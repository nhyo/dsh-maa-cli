// Background MaaCore execution: recovery loop, generated files, copilot fallback, run-end notification.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { addRunCheckpoint, beginRun, finishRun, getRun, setRunProcess, summarizeRun, updateRunProgress, updateRunRecovery } from '../commands/run-state.js'
import { callbackCheckpoint, decideRecovery, diagnoseExecutionFailure, isCopilotJobFailure, isExecutionFailure, MAX_RECOVERY_RETRIES } from '../agent/recovery-manager.js'
import { actionArguments, isRuntimePath, queryArguments, runMaa, startMaa } from '../runtime/runner.js'
import { checkEmulator, emulatorErrorMessage } from '../runtime/emulator.js'
import { desktopNotify } from '../runtime/notify.js'
import { activeExecutions, activeRuns, agentKey } from './execution-state.js'
import { completeTriggeredInstructions, parseMaaCallbackLine, processMaaCallback, recruitNotices, startLogTail } from '../commands/runtime-instructions.js'
import { ensureMaaCli } from '../runtime/maa-cli.js'
import { maybeAutoUpdateRuntime } from '../runtime/runtime.js'
import { prepareRuntimeDirectories } from '../runtime/preflight.js'
import { assertNoGeneratedMarkers, materializeGeneratedFiles, materializeStrategy } from '../strategy/compiler.js'
import { GENERATED_TASK_NAME, writeGeneratedTask } from '../commands/planner.js'
import { classifyMaaExecution } from './formatting.js'
import { parseCompletedDepot, saveDepot, stripDepotCallbacks } from '../operators/depot.js'
import { parseCompletedOperatorBox, saveOperatorBox, stripOperBoxCallbacks } from '../operators/operator-box.js'

export let activeStrategyExecution = false

export async function runWithRecovery({ runArguments, runOptions, document, run, active, executionSignal, copilotFallback = null }) {
  let attempt = 0
  while (true) {
    active.failureCallbacks = []
    await updateRunRecovery(run.id, { status: attempt > 0 ? 'retrying' : 'monitoring', attempt, maxRetries: MAX_RECOVERY_RETRIES, needsUser: false, nextRetryAt: null })
    let result = null
    let failureError = null
    try {
      const handle = startMaa(runArguments, { ...runOptions, hardTimeoutMs: 6 * 60 * 60_000 })
      active.pid = handle.pid
      active.kill = handle.kill
      // Persist the exact process tree so a stop after a DSH restart targets
      // it, and never another DSH instance's or the user's own MAA.
      await setRunProcess(run.id, handle.pid).catch(() => {})
      // Cleared by the first TaskChainStart callback (see the log tail).
      await updateRunProgress(run.id, { startup: STARTUP_PROGRESS }).catch(() => {})
      result = await handle.done
      await updateRunProgress(run.id, { startup: '' }).catch(() => {})
      if (!isExecutionFailure(result)) {
        if (attempt > 0) await updateRunRecovery(run.id, { status: 'recovered', needsUser: false, historyEntry: { at: Date.now(), action: 'recovered', detail: `第 ${attempt} 次重试后任务恢复。` } })
        else await updateRunRecovery(run.id, { status: 'not_needed' })
        return result
      }
    } catch (error) {
      await updateRunProgress(run.id, { startup: '' }).catch(() => {})
      if (error?.name === 'AbortError') throw error
      failureError = error
    }

    const diagnosis = diagnoseExecutionFailure({ result, error: failureError, callbacks: active.failureCallbacks })
    // A failed community job is replaced by the next ranked one (at most
    // COPILOT_MAX_SWITCHES); this does not spend the generic retry budget.
    if (copilotFallback && !executionSignal?.aborted && isCopilotJobFailure({ result, callbacks: active.failureCallbacks, diagnosis })) {
      const switched = await copilotFallback.next(diagnosis)
      if (switched) continue
    }
    const latest = await getRun(run.id)
    let emulator = null
    if (diagnosis.suggestedAction === 'probe_adb') emulator = await checkEmulator({ runMaa, signal: executionSignal }).catch(() => null)
    const decision = decideRecovery({ diagnosis, document, attempt, checkpoints: latest?.checkpoints ?? [], emulator })
    await updateRunRecovery(run.id, {
      status: decision.action === 'retry' ? 'waiting_retry' : 'needs_user',
      attempt,
      diagnosis,
      needsUser: decision.action !== 'retry',
      nextRetryAt: decision.action === 'retry' ? Date.now() + decision.delayMs : null,
      historyEntry: { at: Date.now(), action: decision.action, detail: `${diagnosis.reason} ${decision.reason}` },
    })
    if (decision.action !== 'retry') {
      if (result) return result
      throw failureError ?? new Error(diagnosis.reason)
    }
    await abortableDelay(decision.delayMs, executionSignal)
    attempt += 1
  }
}

export const STARTUP_PROGRESS = 'MaaCore 正在启动、加载资源并连接模拟器…'

export const COPILOT_MAX_SWITCHES = 3

// Same stage, same task kind, and nothing the Box is known to lack; the
// ranking already puts fully-owned jobs before unknown ones.
export function pickCopilotFallbacks(ranked, primary) {
  return ranked
    .filter(item => item.id !== primary.id && item.job.kind === primary.job.kind && item.job.stageName === primary.job.stageName && item.ownership?.status !== 'missing')
    .slice(0, COPILOT_MAX_SWITCHES)
}

// Swaps the generated copilot job file for the next ranked community job.
// Every switch is recorded on the run (the panel shows it on its next read)
// and announced with a desktop notification, because the panel never polls.
export function createCopilotFallback({ run, target, current, fallbacks, notify = desktopNotify }) {
  const queue = fallbacks.slice(0, COPILOT_MAX_SWITCHES)
  const switches = []
  let using = { id: String(current?.id ?? ''), title: String(current?.title ?? '') }
  const progress = () => ({ copilot: { current: using, switches: [...switches], remaining: queue.length, max: COPILOT_MAX_SWITCHES } })
  return {
    remaining: () => queue.length,
    announce: async () => { await updateRunProgress(run.id, progress()).catch(() => {}) },
    next: async failure => {
      const item = queue.shift()
      if (!item) return false
      await writeFile(target, `${JSON.stringify(item.content, null, 2)}\n`)
      const to = { id: String(item.id), title: String(item.title ?? '') }
      const reason = failure?.reason || '作业执行失败'
      const detail = `作业 maa://${using.id} 失败（${reason}），自动换第 ${switches.length + 1}/${COPILOT_MAX_SWITCHES} 份：maa://${to.id}「${to.title || '未命名'}」`
      switches.push({ at: Date.now(), from: using, to, reason })
      using = to
      await updateRunProgress(run.id, progress()).catch(() => {})
      await updateRunRecovery(run.id, { historyEntry: { at: Date.now(), action: 'switch_copilot', detail } }).catch(() => {})
      notify('MAA 自动换作业', detail)
      return true
    },
  }
}

// A stop the user clicked needs no announcement; a stop condition that fired
// on its own, a success, or a failure does.
export function runFinishedNotification(run, options = {}) {
  if (!run || !['succeeded', 'failed', 'stopped'].includes(run.status)) return null
  if (run.status === 'stopped' && !options.conditionStop) return null
  const label = run.purpose || run.confirmationCode || run.id
  const title = run.status === 'succeeded' ? 'MAA 任务已完成' : run.status === 'failed' ? 'MAA 任务失败' : 'MAA 任务已按条件停止'
  const body = [label, run.summary, run.duration ? `用时 ${run.duration}` : ''].filter(Boolean).join('\n')
  return { title, body }
}

export function notifyRunFinished(run, options = {}) {
  const notification = runFinishedNotification(run, options)
  if (notification) desktopNotify(notification.title, notification.body)
}

export function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('recovery cancelled'), { name: 'AbortError' }))
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(Object.assign(new Error('recovery cancelled'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function executeDocument(agent, signal, document, planSummary, options = {}) {
  const key = agentKey(agent)
  if (activeExecutions.has(key)) throw new Error('当前 DSH 会话已有一个 MAA 任务正在执行。')
  // A stop/close that arrived while the confirmation was still launching wins:
  // no run record, no process.
  if (options.abortSignal?.aborted) throw Object.assign(new Error('已在开始执行前取消。'), { name: 'AbortError' })
  // Persist the lifecycle before doing any work: the composer control panel and
  // a DSH restart both read this record, not a component's local state.
  const run = await beginRun({
    purpose: options.purpose ?? '',
    planSummary,
    confirmationCode: options.confirmationCode ?? '',
    sessionId: key,
    taskTypes: document.tasks?.map(task => task.type) ?? [],
  })
  const controller = new AbortController()
  // Background runs must not inherit the command's signal: the command plane may
  // abort it the moment the handler returns, which would kill a healthy MAA run.
  const backgroundWanted = options.background === true
  const executionSignal = backgroundWanted
    ? controller.signal
    : (signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
  let resolveCompletion
  const completion = new Promise(resolve => { resolveCompletion = resolve })
  const active = { controller, planSummary, runId: run.id, sessionKey: key, monitor: null, triggerInstructionId: '', failureCallbacks: [], pid: null, kill: null, completion }
  activeExecutions.set(key, active)
  activeRuns.set(run.id, active)
  if (typeof options.onRunStarted === 'function') {
    try { options.onRunStarted(run) } catch {}
  }
  const linkedAbort = () => controller.abort()
  if (options.abortSignal) {
    if (options.abortSignal.aborted) controller.abort()
    else options.abortSignal.addEventListener('abort', linkedAbort, { once: true })
  }
  let strategyExecution = null
  let generatedExecution = null
  let strategyReserved = false
  let recorded = { status: 'failed', exitCode: null, summary: 'MAA 执行没有返回结果。' }
  let detached = false

  const release = async () => {
    // Never let bookkeeping failure hide the execution outcome.
    if (active.monitor) {
      await active.monitor.flush().catch(() => {})
      active.monitor.stop()
    }
    const notices = recruitNotices(await getRun(run.id).catch(() => null))
    if (notices.length) recorded = { ...recorded, summary: `${recorded.summary}｜公招提醒：${notices.join('；')}（未自动确认，请在游戏内处理）` }
    await finishRun(run.id, recorded).catch(() => {})
    await completeTriggeredInstructions(run.id).catch(() => {})
    const finished = await getRun(run.id).catch(() => null)
    notifyRunFinished(finished && summarizeRun(finished), { conditionStop: Boolean(active.triggerInstructionId) })
    try {
      if (generatedExecution) await generatedExecution.restore().catch(() => {})
      if (strategyExecution) await strategyExecution.restore()
    } finally {
      options.abortSignal?.removeEventListener('abort', linkedAbort)
      if (strategyReserved) activeStrategyExecution = false
      if (activeExecutions.get(key) === active) activeExecutions.delete(key)
      if (activeRuns.get(run.id) === active) activeRuns.delete(run.id)
      resolveCompletion(await getRun(run.id).catch(() => null))
    }
  }

  try {
    let installing = false
    const cliPath = await ensureMaaCli(executionSignal, async () => {
      installing = true
      await updateRunProgress(run.id, { maintenance: '首次使用：正在下载并安装 maa-cli、MaaCore 与资源（可能需要几分钟），完成后自动开始任务…' }).catch(() => {})
    }).finally(async () => {
      if (installing) await updateRunProgress(run.id, { maintenance: '' }).catch(() => {})
    })
    let updating = false
    const maintenance = isRuntimePath(cliPath)
      ? await maybeAutoUpdateRuntime({
        run: runMaa, signal: executionSignal, allowed: activeExecutions.size === 1,
        onUpdateStart: async () => {
          updating = true
          await updateRunProgress(run.id, { maintenance: '正在更新 MaaCore 与资源（每 24 小时检查一次，通常约 1 分钟），完成后自动开始任务…' }).catch(() => {})
        },
      }).finally(async () => {
        if (updating) await updateRunProgress(run.id, { maintenance: '' }).catch(() => {})
      })
      : { warning: '' }
    if (options.emulatorChecked !== true) {
      const emulator = await checkEmulator({ runMaa, signal: executionSignal })
      if (!emulator.ok) throw new Error(emulatorErrorMessage(emulator))
    }
    await prepareRuntimeDirectories({ runMaa, signal: executionSignal }).catch(() => [])
    // Ask the exact maa-cli process where it reads configuration. This matters
    // when the plugin-private runtime redirects MAA_CONFIG_DIR.
    const configResult = await runMaa(queryArguments('config_dir'), { signal: executionSignal, timeoutMs: 20_000 })
    const configDir = configResult.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
    if (configResult.exitCode !== 0 || !configDir) {
      throw new Error(`无法确定 maa-cli 配置目录：${configResult.stderr || configResult.stdout || `exit ${configResult.exitCode}`}`)
    }
    let executionDocument = document
    if (options.strategy) {
      if (activeStrategyExecution) throw new Error('另一条 MAA 策略正在覆盖共享资源，请等它结束后再确认。')
      activeStrategyExecution = true
      strategyReserved = true
      const resourceResult = await runMaa(queryArguments('resource_dir'), { signal: executionSignal, timeoutMs: 20_000 })
      const resourceDir = resourceResult.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
      if (resourceResult.exitCode !== 0 || !resourceDir) {
        throw new Error(`无法确定 MAA 资源目录：${resourceResult.stderr || resourceResult.stdout || `exit ${resourceResult.exitCode}`}`)
      }
      strategyExecution = await materializeStrategy(document, options.strategy, { resourceDir, configDir })
      executionDocument = strategyExecution.document
      const runtimeFallbacks = strategyExecution.unsupported.filter(item => !planSummary.includes(item.request))
      if (runtimeFallbacks.length) planSummary = `${planSummary}｜执行时安全回退：${runtimeFallbacks.map(item => item.request).join('、')}`
    }
    if (Array.isArray(options.generatedFiles) && options.generatedFiles.length > 0) {
      generatedExecution = await materializeGeneratedFiles(executionDocument, options.generatedFiles, { configDir })
      executionDocument = generatedExecution.document
    }
    assertNoGeneratedMarkers(executionDocument)
    const written = await writeGeneratedTask(executionDocument, { configDir })
    const hasOperatorBox = executionDocument.tasks.some(task => task.type === 'OperBox')
    const hasDepot = executionDocument.tasks.some(task => task.type === 'Depot')
    const settle = async result => {
      const executionFeedback = classifyMaaExecution(result, strategyExecution !== null)
      recorded = {
        status: executionFeedback.status === 'failed' || result.exitCode !== 0 ? 'failed' : 'succeeded',
        exitCode: result.exitCode,
        summary: executionFeedback.headline,
      }
      const enriched = {
        ...result,
        runId: run.id,
        stderr: stripDepotCallbacks(stripOperBoxCallbacks(result.stderr)),
        planFile: written.path, planJson: written.json, planSummary, maintenanceWarning: maintenance.warning, executionFeedback,
      }
      if (result.exitCode !== 0) return enriched
      const completeLog = `${result.stdout}\n${result.stderr}`
      if (hasOperatorBox) {
        try {
          enriched.operatorBox = parseCompletedOperatorBox(completeLog)
          await saveOperatorBox(enriched.operatorBox)
        } catch (error) {
          enriched.operatorBoxError = error instanceof Error ? error.message : String(error)
        }
      }
      if (hasDepot) {
        try {
          enriched.depot = parseCompletedDepot(completeLog)
          await saveDepot(enriched.depot)
        } catch (error) {
          enriched.depotError = error instanceof Error ? error.message : String(error)
        }
      }
      if (enriched.operatorBoxError || enriched.depotError) {
        recorded = { status: 'failed', exitCode: result.exitCode, summary: '任务已执行，但结构化状态缓存不完整。' }
      }
      return enriched
    }
    const runOptions = {
      signal: executionSignal,
      timeoutMs: 30 * 60_000,
      outputLimit: hasOperatorBox || hasDepot ? 16 * 1024 * 1024 : undefined,
      envPatch: hasOperatorBox || hasDepot ? { MAA_LOG: 'info', MAA_LOG_PREFIX: 'Never' } : undefined,
    }
    const runArguments = actionArguments('run_task', GENERATED_TASK_NAME, true, strategyExecution?.userResource === true)
    const logResult = await runMaa(queryArguments('log_dir'), { signal: executionSignal, timeoutMs: 20_000 })
    const logDir = logResult.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
    if (logResult.exitCode === 0 && logDir) {
      const seen = new Set()
      active.monitor = await startLogTail(path.join(logDir, 'asst.log'), async line => {
        const callback = parseMaaCallbackLine(line)
        if (!callback) return
        const signature = line
        if (seen.has(signature)) return
        seen.add(signature)
        if (seen.size > 200) seen.delete(seen.values().next().value)
        active.failureCallbacks.push(callback)
        if (active.failureCallbacks.length > 100) active.failureCallbacks.shift()
        const checkpoint = callbackCheckpoint(callback)
        if (checkpoint) await addRunCheckpoint(run.id, checkpoint)
        if (checkpoint?.status === 'started') await updateRunProgress(run.id, { startup: '' }).catch(() => {})
        await processMaaCallback(run.id, callback, {
          stop: instructionId => {
            active.triggerInstructionId = instructionId
            controller.abort()
          },
        })
      })
    }
    const copilotFallback = generatedExecution?.files?.length === 1 && Array.isArray(options.copilotFallbacks) && options.copilotFallbacks.length > 0
      ? createCopilotFallback({ run, target: generatedExecution.files[0], current: options.copilotCurrent, fallbacks: options.copilotFallbacks })
      : null
    if (copilotFallback) await copilotFallback.announce()
    const execution = runWithRecovery({ runArguments, runOptions, document: executionDocument, run, active, executionSignal, copilotFallback })
    if (!backgroundWanted) return await settle(await execution)
    // Background mode: return as soon as the first MAA attempt is running. The
    // recovery loop and process tree remain owned by this plugin process.
    detached = true
    void execution
      .then(result => settle(result))
      .catch(error => {
        recorded = error?.name === 'AbortError'
          ? { status: 'stopped', exitCode: null, summary: '已停止。' }
          : { status: 'failed', exitCode: null, summary: error instanceof Error ? error.message : String(error) }
      })
      .finally(() => { void release() })
    return {
      background: true,
      runId: run.id,
      pid: active.pid,
      planFile: written.path,
      planJson: written.json,
      planSummary,
      maintenanceWarning: maintenance.warning,
      executionFeedback: {
        status: 'running',
        headline: 'MAA 已开始执行。',
        detail: '任务在后台运行：面板显示「执行中」与本地计时，需要中止时点击「停止任务」或输入 /maa stop；结束后点「查看执行记录」查看结果。',
        statuses: [],
      },
    }
  } catch (error) {
    recorded = error?.name === 'AbortError'
      ? { status: 'stopped', exitCode: null, summary: '已停止。' }
      : { status: 'failed', exitCode: null, summary: error instanceof Error ? error.message : String(error) }
    throw error
  } finally {
    // A detached child settles the record itself when it exits.
    if (!detached) await release()
  }
}
