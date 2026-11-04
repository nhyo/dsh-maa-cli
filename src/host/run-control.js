// Stop, ownership, session status, runtime instructions and the restart audit.
import { activeRun, clearRunStopping, describeRunState, getRun, markRunStopping, readRunState, stopRun } from '../commands/run-state.js'
import { formatStopOutcome, summarizeForStop } from './formatting.js'
import { activeRuns, activeWorkflows, agentKey, launches, ownershipRefusal, runOwnership, stopRequests } from './execution-state.js'
import { applyRuntimeInstruction, completeTriggeredInstructions } from '../commands/runtime-instructions.js'
import { peekPendingPlan } from '../commands/confirmation.js'
import { auditInterruptedWorkflows, updateWorkflowExecution } from '../agent/workflow-manager.js'
import { getGoal, updateGoal } from '../agent/goal-manager.js'
import { queryArguments, runMaa } from '../runtime/runner.js'
import { recoverStrategyOverlay } from '../strategy/compiler.js'

export const STOP_WAIT_MS = 30_000

export async function executeRuntimeInstruction(request, agent = null) {
  const running = await activeRun()
  if (!running) return { status: 'not_running', message: '当前没有正在执行的 MAA 任务。', run: null }
  if (request.action === 'stop_now') {
    if (!agent) return { status: 'not_owned', message: '立即停止需要明确的 DSH 会话。', run: running }
    const stopped = await stopExecution(agent, running.id)
    return { ...stopped, message: stopped.message ?? formatStopOutcome(stopped).text }
  }
  // Read-only progress is shared; anything that changes the run stays with
  // the session that owns it.
  if (agent && request.action !== 'status') {
    const ownership = runOwnership(running, agentKey(agent))
    if (ownership === 'other' || ownership === 'foreign') return { status: 'not_owned', message: ownershipRefusal(running, ownership), run: running }
  }
  const active = activeRuns.get(running.id)
  const result = await applyRuntimeInstruction(running.id, request, {
    monitorAvailable: Boolean(active?.monitor),
    stop: instructionId => {
      if (!active) return
      active.triggerInstructionId = instructionId
      active.controller.abort()
    },
  })
  const latest = await getRun(running.id)
  return { ...result, run: latest }
}

export function settleWithin(promise, ms) {
  let timer
  return Promise.race([
    Promise.resolve(promise).then(value => ({ settled: true, value }), error => ({ settled: true, error })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export function stopWaitMs() {
  const configured = Number(process.env.DSH_MAA_STOP_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : STOP_WAIT_MS
}

// Stop exactly one run (or a confirmation that is still launching) on behalf
// of one DSH session. `target` may be a RUN-…, a MAA-… confirmation code or a
// workflow id; without a target the caller's own current task is stopped.
// Resolves only after the process tree has exited and the record, temporary
// resources and instructions have been settled — or reports why it could not.
export async function stopExecution(agent, target = '') {
  const key = agentKey(agent)
  const wanted = String(target ?? '').trim().toUpperCase()
  const matches = (...ids) => wanted === '' || ids.some(id => id && String(id).toUpperCase() === wanted)

  // 1. A `/maa confirm` of this session that has not produced a run yet.
  const launch = launches.get(key)
  let launchCode = ''
  if (launch && matches(launch.code, launch.runId)) {
    launchCode = launch.code
    launch.controller.abort()
    const waited = await settleWithin(launch.settled, stopWaitMs())
    if (!waited.settled) {
      return { status: 'stop_failed', run: null, code: launch.code, message: `停止请求已发出，但确认流程在 ${Math.round(stopWaitMs() / 1000)} 秒内没有结束；请稍后重试停止。` }
    }
  }

  // 2. Goal workflows started from this session.
  const workflows = [...activeWorkflows.values()].filter(item => item.sessionKey === key && matches(item.executionId, item.confirmationCode, item.runId))
  for (const workflow of workflows) workflow.controller.abort()

  // 3. The run record itself.
  const state = await readRunState()
  const lookup = wanted || launchCode
  let run = lookup
    ? state.runs.find(item => item.id.toUpperCase() === lookup || (item.confirmationCode && item.confirmationCode.toUpperCase() === lookup)) ?? null
    : null
  if (!run && workflows.length) run = state.runs.find(item => item.status === 'running' && item.sessionId === key) ?? null
  if (!run && !lookup) {
    // The caller's own task first; then whatever is live (ownership decides
    // whether this session may touch it); finally an interrupted leftover.
    run = state.runs.find(item => item.status === 'running' && item.sessionId === key)
      ?? await activeRun()
      ?? state.runs.find(item => item.status === 'running')
      ?? null
  }
  if (!run) {
    if (workflows.length) {
      await settleWithin(Promise.all(workflows.map(item => item.done)), stopWaitMs())
      return { status: 'stopped', run: null, message: '目标工作流已停止。' }
    }
    if (launchCode) return { status: 'cancelled_launch', run: null, code: launchCode, message: `已在开始执行前取消（${launchCode}）；没有启动 MAA，确认码已失效。` }
    return { status: 'not_running', run: null }
  }
  if (run.status !== 'running') return { status: 'already_finished', run: summarizeForStop(run) }
  const ownership = runOwnership(run, key)
  if (ownership === 'other' || ownership === 'foreign') return { status: 'not_owned', run: summarizeForStop(run), message: ownershipRefusal(run, ownership) }

  const existing = stopRequests.get(run.id)
  if (existing) return await existing
  const request = (async () => {
    if (ownership === 'orphan') {
      try {
        const stopped = await stopRun(run.id, { summary: '已停止（终止了 DSH 不再持有的残留进程树）。' })
        await completeTriggeredInstructions(run.id).catch(() => {})
        return { status: 'stopped', run: summarizeForStop(stopped) }
      } catch (error) {
        return { status: 'stop_failed', run: summarizeForStop(await getRun(run.id)), message: error instanceof Error ? error.message : String(error) }
      }
    }
    const active = activeRuns.get(run.id)
    if (!active) {
      // It settled between the lookup and now.
      const settled = await getRun(run.id)
      return settled?.status === 'running'
        ? { status: 'stop_failed', run: summarizeForStop(settled), message: '任务状态正在切换，请重试停止。' }
        : { status: 'already_finished', run: summarizeForStop(settled) }
    }
    await markRunStopping(run.id)
    await applyRuntimeInstruction(run.id, { action: 'stop_now' }, {
      monitorAvailable: Boolean(active?.monitor),
      stop: instructionId => { active.triggerInstructionId = instructionId },
    }).catch(() => {})
    active.controller.abort()
    // Re-issue the tree kill on every attempt: a previous attempt may have
    // failed (access denied, taskkill missing) and the user is retrying.
    const kill = typeof active.kill === 'function' ? await active.kill().catch(error => ({ ok: false, detail: error.message })) : { ok: true }
    const waited = await settleWithin(active.completion, stopWaitMs())
    if (!waited.settled) {
      const reason = `MAA 进程在 ${Math.round(stopWaitMs() / 1000)} 秒内没有退出${kill && kill.ok === false ? `（${kill.detail}）` : ''}。`
      await clearRunStopping(run.id, reason).catch(() => {})
      return { status: 'stop_failed', run: summarizeForStop(await getRun(run.id)), message: `停止失败：${reason}任务仍在执行，停止按钮保持可用，可以重试。` }
    }
    await settleWithin(Promise.all(workflows.map(item => item.done)), stopWaitMs())
    return { status: 'stopped', run: summarizeForStop(await getRun(run.id)) }
  })()
  stopRequests.set(run.id, request)
  try { return await request } finally { if (stopRequests.get(run.id) === request) stopRequests.delete(run.id) }
}

// What the composer dock of ONE session needs after a refresh, a DSH restart
// or a conversation switch: the live run with its ownership, a confirmation
// that is still launching, and the session's own pending plan (code only).
export async function sessionRunStatus(agent) {
  const key = agentKey(agent)
  const snapshot = await describeRunState()
  const raw = await readRunState()
  const annotate = item => {
    if (!item) return null
    const record = raw.runs.find(run => run.id === item.id)
    return { ...item, owner: runOwnership(record, key) }
  }
  const launch = launches.get(key)
  let pending = null
  try {
    const plan = await peekPendingPlan(agent)
    if (Date.now() - Number(plan.preparedAt) <= 30 * 60_000) pending = { code: plan.confirmationCode, summary: plan.planSummary ?? '' }
  } catch {}
  return {
    ...snapshot,
    running: annotate(snapshot.running),
    interrupted: annotate(snapshot.interrupted),
    launching: launch ? { code: launch.code, runId: launch.runId || '' } : null,
    pending,
  }
}

export async function cancelPendingWorkflow(executionId, goalId = '') {
  await updateWorkflowExecution(executionId, value => {
    if (value.status === 'pending_confirmation') {
      value.status = 'cancelled'
      value.needsUser = ''
    }
    return value
  })
  if (goalId) {
    const goal = await getGoal(goalId)
    if (goal?.status === 'pending_confirmation' && goal.workflowExecutionId === executionId) await updateGoal(goalId, { status: 'cancelled', needsUser: '' })
  }
}

// A running MAA task owns the emulator, the generated task file, and the user
// resource overlay. Until it ends no new plan may replace them, not even from
// another DSH session.
export async function assertNoActiveRun() {
  if (activeWorkflows.size > 0) throw new Error('当前有目标工作流正在执行或等待步骤反馈，请先停止或处理该工作流。')
  const running = await activeRun()
  if (!running) return
  throw new Error(`MAA 任务正在执行中（${running.purpose || running.confirmationCode || running.id}，已运行 ${new Date(running.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} 起）。为避免抢屏幕和覆盖临时资源，完成前不接受新的计划或任务；可以等待，或在确认面板点击「停止任务」/ 输入 /maa stop。`)
}

export async function recoverAfterRestart() {
  const interrupted = await auditInterruptedWorkflows()
  const state = await readRunState()
  let reaped = { killed: 0 }
  // Every record still marked running was started by an earlier plugin process
  // (this one has not started anything yet). Leave records that a different,
  // still-alive DSH process owns; terminate only the recorded process tree of
  // genuine orphans and settle their record.
  for (const orphan of state.runs.filter(run => run.status === 'running' && !activeRuns.has(run.id))) {
    if (runOwnership(orphan, '') === 'foreign') continue
    const stopped = await stopRun(orphan.id, { summary: 'DSH 重启后已终止残留任务并结算记录。' }).catch(() => null)
    if (stopped) reaped = { killed: reaped.killed + 1 }
  }
  let overlay = null
  try {
    const result = await runMaa(queryArguments('config_dir'), { timeoutMs: 20_000 })
    const configDir = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1)
    if (result.exitCode === 0 && configDir) overlay = await recoverStrategyOverlay(configDir)
  } catch {}
  return { interrupted, reaped: reaped.killed, overlay }
}
