// The zero-model `/maa` command.
import { parseLocalMaaCommand } from '../commands/local-command.js'
import { bootstrapRuntime, formatRuntimeReport, inspectRuntime } from '../runtime/runtime.js'
import { runMaa } from '../runtime/runner.js'
import { cancelPendingWorkflow, executeRuntimeInstruction, sessionRunStatus, stopExecution } from './run-control.js'
import { cancelPendingPlan, peekPendingPlan, preparePendingPlan } from '../commands/confirmation.js'
import { agentKey, launches } from './execution-state.js'
import { formatBackgroundResult, formatCommandResult, formatRuntimeInstructionResult, formatStopOutcome } from './formatting.js'
import { reapGeneratedTaskProcesses } from '../commands/run-state.js'
import { panelContext, prepareNotePreview, publicNotePreview, roguelikeThemeOf, strategyEnvironment } from './plan-environment.js'
import { getWorkflowExecution } from '../agent/workflow-manager.js'
import { applyTaskPanelOverrides, readOnlyPlanPanel, taskPanelFromDocument } from '../commands/task-panel.js'
import { applyRememberedConfig } from '../commands/panel-memory.js'
import { deleteStrategyMemory, listStrategyMemory, setStrategyMemoryEnabled } from '../strategy/memory.js'
import { confirmPlan } from './confirm.js'
import { buildTaskDocument, summarizePlan } from '../commands/planner.js'
import { executeDocument } from './execution.js'
import { describeExtensions, installExtension, previewInstall } from '../extensions/host.js'

let launchQueue = Promise.resolve()

export function registerMaaCommand(ctx) {
  ctx.commands.register({
    name: 'maa',
    definitionId: 'dsh-maa-cli/maa',
    description: '直接运行常用 MAA 操作，不调用模型',
    input: { hint: '<startup | fight | infrast | recruit | mall | award | rouge | reclamation | update | closedown | help>' },
    async handler({ agent, rawInput, signal }) {
      try {
        const parsed = parseLocalMaaCommand(rawInput)
        if (parsed.kind === 'help') return { kind: 'success', text: parsed.text }
        if (parsed.kind === 'ext-list') return { kind: 'success', text: describeExtensions(ctx) }
        // Installing changes the user's DSH profile and downloads a package, so
        // the first command only previews; the user confirms with a second one.
        if (parsed.kind === 'ext-install') return parsed.confirmed ? await installExtension(ctx, parsed.id, { signal }) : previewInstall(ctx, parsed.id)
        if (parsed.kind === 'setup') {
          const steps = []
          await bootstrapRuntime({
            run: runMaa,
            signal,
            onStep: (id, detail) => steps.push({ id, detail }),
          })
          const status = await inspectRuntime()
          return {
            kind: status.installed ? 'success' : 'error',
            text: `${formatRuntimeReport(status)}${steps.length ? `\n\n${steps.map(step => `- ${step.id}：${step.detail}`).join('\n')}` : ''}`,
          }
        }
        if (parsed.kind === 'status') {
          // Same snapshot as the silent `/dsh-maa-cli` status RPC. The client only
          // falls back to this command when that channel is unavailable, because
          // command results are echoed into the transcript.
          return { kind: 'success', text: JSON.stringify(await sessionRunStatus(agent)) }
        }
        if (parsed.kind === 'cancel') {
          try {
            const cancelled = await cancelPendingPlan(agent, parsed.confirmationCode)
            if (cancelled.workflowExecutionId) await cancelPendingWorkflow(cancelled.workflowExecutionId, cancelled.goalId).catch(() => {})
            return {
              kind: 'success',
              text: cancelled.alreadyClosed
                ? `待确认计划 ${parsed.confirmationCode} 已经失效（${cancelled.status === 'expired' ? '超过有效期' : cancelled.status === 'superseded' ? '已被新计划替换' : '此前已取消'}），无需再次取消。`
                : `已取消待确认计划 ${cancelled.confirmationCode}；该确认码已失效。`,
            }
          } catch (error) {
            if (error?.code === 'MAA_PLAN_CONFIRMED') {
              // The plan already became a run (or is launching): point the panel
              // at it instead of pretending the plan was cancelled.
              const runId = error.closed?.runId || launches.get(agentKey(agent))?.runId || ''
              return { kind: 'error', text: `计划 ${parsed.confirmationCode} 已经确认并${runId ? `开始执行（${runId}）` : '正在启动'}，不能再取消；如需终止请停止任务。` }
            }
            throw error
          }
        }
        if (parsed.kind === 'runtime-instruction' && parsed.request.action === 'stop_now') {
          return formatStopOutcome(await stopExecution(agent, ''))
        }
        if (parsed.kind === 'runtime-instruction') {
          const result = await executeRuntimeInstruction(parsed.request, agent)
          return { kind: ['not_running', 'not_owned'].includes(result.status) ? 'error' : 'success', text: formatRuntimeInstructionResult(result) }
        }
        if (parsed.kind === 'stop') {
          const outcome = await stopExecution(agent, parsed.target ?? '')
          if (outcome.status !== 'not_running' || parsed.target) return formatStopOutcome(outcome)
          // Nothing recorded as running. A legacy maa-cli left behind by an
          // older version (no recorded pid) can still be cleaned by name.
          const reaped = await reapGeneratedTaskProcesses()
          return {
            kind: reaped.killed > 0 ? 'success' : 'error',
            text: reaped.killed > 0
              ? `已清理 ${reaped.killed} 个残留的 dsh-generated maa-cli 进程。`
              : '当前没有正在执行的 MAA 任务。',
          }
        }
        if (parsed.kind === 'peek') {
          // Read-only: the local client asks for the pending plan's MAA-style
          // field definitions and current values. Nothing is consumed here.
          const pending = await peekPendingPlan(agent)
          if (parsed.confirmationCode && parsed.confirmationCode !== pending.confirmationCode) {
            throw new Error('MAA 确认码与待确认计划不一致。')
          }
          const environment = await strategyEnvironment(signal)
          const workflow = pending.workflowExecutionId ? await getWorkflowExecution(pending.workflowExecutionId) : null
          const panel = workflow
            ? {
                type: 'Workflow', title: '目标工作流', fields: [], values: {},
                notes: workflow.steps.map((step, index) => ({ text: `${index + 1}. ${step.title}${step.kind === 'decision' ? '（到此暂停并请求人工决策）' : ''}` })),
              }
            : (pending.panelMemory === false
              // A plan prepared from the user's words is the authority: the
              // panel shows exactly what the model planned. Remembered values
              // only prefill the zero-model /maa panels.
              ? taskPanelFromDocument(pending.document, environment.capabilities, panelContext(environment))
              : await applyRememberedConfig(taskPanelFromDocument(pending.document, environment.capabilities, panelContext(environment)), { explicitKeys: pending.panelExplicitKeys }))
              ?? readOnlyPlanPanel(pending.document)
          return {
            kind: 'success',
            text: JSON.stringify({
              code: pending.confirmationCode,
              summary: pending.planSummary,
              theme: roguelikeThemeOf(pending.document),
              panel,
              capabilitySignature: environment.capabilities.signature,
              capabilitySource: environment.capabilities.source,
              capabilityWarning: environment.capabilities.warning ?? '',
              notePreview: publicNotePreview(pending.notePreview),
              goal: pending.goalPreview ?? null,
              workflow,
            }),
          }
        }
        if (parsed.kind === 'note-preview') {
          const preview = await prepareNotePreview(agent, parsed.confirmationCode, parsed.note, parsed.overrides, signal)
          return { kind: 'success', text: JSON.stringify(publicNotePreview(preview)) }
        }
        if (parsed.kind === 'strategies') {
          return { kind: 'success', text: JSON.stringify(await listStrategyMemory()) }
        }
        if (parsed.kind === 'strategy-enable' || parsed.kind === 'strategy-disable') {
          const changed = await setStrategyMemoryEnabled(parsed.id, parsed.kind === 'strategy-enable')
          return { kind: 'success', text: JSON.stringify(changed) }
        }
        if (parsed.kind === 'strategy-delete') {
          return { kind: 'success', text: JSON.stringify(await deleteStrategyMemory(parsed.id)) }
        }
        if (parsed.kind === 'confirm') {
          const key = agentKey(agent)
          const current = launches.get(key)
          if (current) {
            throw new Error(current.code === parsed.confirmationCode
              ? `计划 ${parsed.confirmationCode} 正在启动，请勿重复确认。`
              : `本会话正在启动另一个计划（${current.code}），请等待它开始或停止后再确认。`)
          }
          const launch = { code: parsed.confirmationCode, controller: new AbortController(), runId: '', settled: null }
          launches.set(key, launch)
          // Launch phases are serialized across ALL sessions: two confirmations
          // arriving together must not both pass the "no active run" check and
          // then have the loser's code burned without anything running.
          const confirmation = launchQueue.then(() => confirmPlan(agent, parsed, signal, launch))
          launchQueue = confirmation.catch(() => {})
          launch.settled = confirmation
          try {
            return await confirmation
          } catch (error) {
            if (error?.name === 'AbortError' && launch.controller.signal.aborted) {
              return { kind: 'error', text: launch.runId ? `任务已在启动阶段被停止（${launch.runId}）。` : `已在开始执行前取消（${parsed.confirmationCode}）；没有启动 MAA。` }
            }
            throw error
          } finally {
            if (launches.get(key) === launch) launches.delete(key)
          }
        }
        const environment = await strategyEnvironment(signal)
        let document = buildTaskDocument(parsed.steps, environment.capabilities)
        let summary = summarizePlan(parsed.steps, environment.capabilities, panelContext(environment))
        // Parameter adjustments are validated against the same whitelist the
        // confirmation panel uses, and a bad value aborts before anything is
        // written or executed.
        const overrides = parsed.roguelikeOverrides ?? {}
        if (Object.keys(overrides).length > 0) {
          const patched = applyTaskPanelOverrides(document, overrides, environment.capabilities, panelContext(environment))
          document = patched.document
          if (patched.applied.length > 0) summary = `${summary}｜参数：${patched.applied.join('、')}`
        }
        if (parsed.kind === 'plan') {
          // Every zero-model task only prepares: the client turns this notice
          // into its MAA-style parameter panel, and the button executes
          // `/maa confirm` on the local command plane. No model turn, no tokens.
          const pending = await preparePendingPlan(agent, {
            planSummary: summary, document,
            panelExplicitKeys: Array.isArray(parsed.panelExplicitKeys) ? parsed.panelExplicitKeys : [],
          })
          return {
            kind: 'success',
            text: `MAA 计划待确认：${summary}\n确认码 ${pending.confirmationCode}（30 分钟内有效）。参数面板已在输入框上方打开，确认后执行；也可以输入 /maa confirm ${pending.confirmationCode}。`,
          }
        }
        const result = await executeDocument(agent, signal, document, summary, { background: true })
        if (result.background) return { kind: 'success', text: formatBackgroundResult(result) }
        return { kind: result.executionFeedback?.status !== 'failed' && !result.operatorBoxError ? 'success' : 'error', text: formatCommandResult(result) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
