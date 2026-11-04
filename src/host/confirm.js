// The human-gesture confirmation of a pending plan.
import { assertPlanCodeOpen, cancelPendingPlan, consumePlanFromHumanGesture, peekPendingPlan, recordPlanRun } from '../commands/confirmation.js'
import { assertNoActiveRun } from './run-control.js'
import { startWorkflowExecution, workflowSummary } from './goal-workflow.js'
import { ensureMaaCli } from '../runtime/maa-cli.js'
import { checkEmulator, emulatorErrorMessage } from '../runtime/emulator.js'
import { runMaa } from '../runtime/runner.js'
import { decodeConfirmationNote, formatBackgroundResult, formatCommandResult } from './formatting.js'
import { memorySummary, panelContext, rememberConfirmedPanel, roguelikeThemeOf, strategyEnvironment } from './plan-environment.js'
import { applyStrategyMemory } from '../strategy/memory.js'
import { applyTaskPanelOverrides } from '../commands/task-panel.js'
import { executeDocument } from './execution.js'

// The human-gesture confirmation. `launch.controller` is aborted by a stop or
// close that arrives before the run exists; every await below re-checks it so
// an aborted confirmation never consumes the code or starts MAA afterwards.
export async function confirmPlan(agent, parsed, signal, launch) {
  const launchSignal = launch.controller.signal
  let consumed = false
  try {
    return await confirmPlanSteps(agent, parsed, signal, launch, () => { consumed = true })
  } catch (error) {
    // Aborted before the code was consumed: also invalidate the code so the
    // stopped confirmation can never be replayed later.
    if (launchSignal.aborted && !consumed) {
      await cancelPendingPlan(agent, parsed.confirmationCode).catch(() => {})
      throw Object.assign(new Error('已在开始执行前取消。'), { name: 'AbortError' })
    }
    throw error
  }
}

export async function confirmPlanSteps(agent, parsed, signal, launch, markConsumed) {
  const launchSignal = launch.controller.signal
  const waitSignal = signal ? AbortSignal.any([signal, launchSignal]) : launchSignal
  const checkpoint = () => {
    if (launchSignal.aborted) throw Object.assign(new Error('已在开始执行前取消。'), { name: 'AbortError' })
  }
  // The slash command or the button that invokes it is the explicit
  // human authorization; the pending plan remains scoped and one-shot.
  checkpoint()
  await assertPlanCodeOpen(agent, parsed.confirmationCode)
  await assertNoActiveRun()
  const pendingPreview = await peekPendingPlan(agent)
  checkpoint()
  if (pendingPreview.workflowExecutionId) {
    if (Object.keys(parsed.overrides ?? {}).length > 0) throw new Error('目标工作流不接受任务面板参数覆盖；请编辑目标或工作流后重新生成。')
    const pending = await consumePlanFromHumanGesture(agent, parsed.confirmationCode)
    markConsumed()
    const execution = await startWorkflowExecution(agent, pending.workflowExecutionId, pending.goalId, pending.confirmationCode)
    return { kind: 'success', text: `目标工作流已开始（${execution.id}）。${workflowSummary(execution)}\n每一步只在 MAA 明确验证完成后继续；遇到人工决策、未知状态或预算风险会自动暂停。` }
  }
  await ensureMaaCli(waitSignal)
  checkpoint()
  const emulator = await checkEmulator({ runMaa, signal: waitSignal })
  checkpoint()
  if (!emulator.ok) throw new Error(emulatorErrorMessage(emulator))
  // Validate confirmation-time parameter overrides against the pending
  // document before consuming it, so a bad value never burns the code.
  const overrides = { ...(parsed.overrides ?? {}) }
  let note = ''
  if (overrides.note !== undefined) {
    note = decodeConfirmationNote(overrides.note)
    delete overrides.note
  }
  const hasOverrides = Object.keys(overrides).length > 0
  const peeked = hasOverrides || note ? await peekPendingPlan(agent) : null
  let confirmationDocument = peeked?.document
  let confirmationStrategy = peeked?.strategy
  let noteSummary = ''
  if (note) {
    const preview = peeked?.notePreview
    if (!preview || preview.status !== 'ready' || preview.note !== note) {
      throw new Error('备注尚未完成策略预览，或预览后又被修改。请先点击“解析并预览备注”。')
    }
    if (JSON.stringify(preview.overrides ?? {}) !== JSON.stringify(overrides)) {
      throw new Error('任务参数在备注预览后发生变化，请重新点击“解析并预览备注”。')
    }
    confirmationDocument = preview.document
    confirmationStrategy = preview.strategy
    noteSummary = `｜备注策略：${preview.supported.join('、')}${preview.unsupported.length ? `｜未执行：${preview.unsupported.map(item => item.request).join('、')}` : ''}`
    if (preview.adjustments?.length) noteSummary += `｜确认时调整：${preview.adjustments.join('、')}`
    try {
      const environment = await strategyEnvironment(signal)
      const committed = await applyStrategyMemory(confirmationStrategy, { ...environment, includeStored: false })
      confirmationStrategy = committed.strategy
      noteSummary += memorySummary(committed.memory)
    } catch (error) {
      noteSummary += `｜策略记忆未更新：${error instanceof Error ? error.message : String(error)}`
    }
  }
  const confirmationEnvironment = hasOverrides && !note ? await strategyEnvironment(signal) : null
  const patched = hasOverrides && !note ? applyTaskPanelOverrides(confirmationDocument, overrides, confirmationEnvironment.capabilities, panelContext(confirmationEnvironment)) : null
  const adjustments = patched && patched.applied.length > 0 ? `｜确认时调整：${patched.applied.join('、')}` : ''
  checkpoint()
  const pending = await consumePlanFromHumanGesture(agent, parsed.confirmationCode)
  markConsumed()
  const planSummary = `${pending.planSummary}${adjustments}${noteSummary}`
  const finalDocument = patched ? patched.document : (confirmationDocument ?? pending.document)
  // Remember what the human actually confirmed, so the next panel opens
  // with the same theme/difficulty/squad instead of MAA's defaults.
  await rememberConfirmedPanel(finalDocument, confirmationEnvironment).catch(() => {})
  // Keep the run label honest: the panel may have switched the theme at
  // confirm time, and the dock must not claim the old theme.
  const finalTheme = roguelikeThemeOf(finalDocument)
  const baseTheme = roguelikeThemeOf(pending.document)
  const purpose = finalTheme !== '' && baseTheme !== '' && finalTheme !== baseTheme
    ? `肉鸽 ${finalTheme}（确认时从 ${baseTheme} 切换）`
    : pending.purpose
  const result = await executeDocument(agent, signal, finalDocument, planSummary, {
    background: true, emulatorChecked: true, strategy: confirmationStrategy ?? pending.strategy, generatedFiles: pending.generatedFiles, purpose, confirmationCode: pending.confirmationCode,
    copilotCurrent: pending.copilotCurrent, copilotFallbacks: pending.copilotFallbacks,
    abortSignal: launchSignal,
    onRunStarted: run => {
      launch.runId = run.id
      void recordPlanRun(agent, pending.confirmationCode, run.id).catch(() => {})
    },
  })
  if (result.background) return { kind: 'success', text: formatBackgroundResult(result) }
  const text = formatCommandResult(result)
  return { kind: result.executionFeedback?.status !== 'failed' && !result.operatorBoxError ? 'success' : 'error', text }
}
