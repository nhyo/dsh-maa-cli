// Text shapes of command results, stop outcomes and execution feedback.
import { formatOperatorBoxScanResult } from '../operators/operator-box.js'
import { formatDepotScanResult } from '../operators/depot.js'

// The 备注 field arrives URL-encoded on the local command plane so spaces
// survive. It is compiled and previewed by DSH; raw note text is never copied
// into a MaaCore task document.
export function decodeConfirmationNote(raw) {
  let decoded
  try {
    decoded = decodeURIComponent(String(raw ?? ''))
  } catch {
    throw new Error('备注的 URL 编码不合法，请在面板里重新输入。')
  }
  const clean = decoded.replace(/[\r\n\t]+/gu, ' ').trim()
  if (clean === '') return ''
  if (clean.length > 120) throw new Error('备注最多 120 个字符。')
  return clean
}

export function formatCommandResult(result) {
  const feedback = result.executionFeedback ?? classifyMaaExecution(result)
  const lines = [feedback.headline, `计划：${result.planSummary}`, `执行验证：${feedback.detail}`]
  if (result.operatorBox) lines.push('', formatOperatorBoxScanResult(result.operatorBox))
  if (result.operatorBoxError) lines.push('', `干员 Box 结果读取失败：${result.operatorBoxError}`)
  if (result.depot) lines.push('', formatDepotScanResult(result.depot))
  if (result.depotError) lines.push('', `仓库结果读取失败：${result.depotError}`)
  if (result.maintenanceWarning) lines.push('', result.maintenanceWarning)
  if (result.stdout) lines.push('', result.stdout)
  if (result.stderr) lines.push('', result.stderr)
  return lines.join('\n')
}

export function classifyMaaExecution(result, strategyApplied = false) {
  const log = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  const statuses = [...log.matchAll(/^\[([^\]]+)\]\s+(Succeeded|Completed|Failed|Stopped|Unstarted)\s*$/gimu)]
    .map(match => ({ task: match[1], status: match[2] }))
  if (result?.exitCode !== 0) return {
    status: 'failed', headline: `MAA 执行失败（退出码 ${result?.exitCode ?? '未知'}）。`,
    detail: strategyApplied ? '策略配置已生成并交给 MAA，但 MAA 进程返回失败；不能视为策略执行成功。' : 'MAA 进程返回失败。', statuses,
  }
  if (statuses.some(item => item.status === 'Failed')) return {
    status: 'failed', headline: 'MAA 报告任务失败。', detail: '进程退出码为 0，但任务摘要包含 Failed。', statuses,
  }
  if (statuses.length && statuses.every(item => ['Succeeded', 'Completed'].includes(item.status))) return {
    status: 'verified', headline: 'MAA 已完成任务。', detail: `MAA 摘要确认完成：${statuses.map(item => item.task).join('、')}`, statuses,
  }
  const state = statuses.length ? statuses.map(item => `${item.task}=${item.status}`).join('、') : '日志中没有可识别的完成状态'
  return {
    status: 'unverified', headline: 'MAA 进程已正常结束，但任务结果未完全验证。',
    detail: `${state}；${strategyApplied ? '仅能确认策略已生成、加载并调用 MAA，不能据此声称游戏内动作成功。' : '不能仅凭退出码 0 声称游戏内任务成功。'}`,
    statuses,
  }
}

export function summarizeForStop(run) {
  if (!run) return null
  return { id: run.id, status: run.status, purpose: run.purpose, confirmationCode: run.confirmationCode, summary: run.summary, exitCode: run.exitCode, stopError: run.stopError ?? '' }
}

export function formatStopOutcome(outcome) {
  const run = outcome.run
  if (outcome.status === 'stopped' && run) {
    return { kind: 'success', text: `MAA 任务已${run.status === 'stopped' ? '停止' : '结束'}（${run.id}）；进程已退出，运行记录与临时资源已完成结算。` }
  }
  if (outcome.status === 'stopped') return { kind: 'success', text: outcome.message || '任务已停止。' }
  if (outcome.status === 'cancelled_launch') return { kind: 'success', text: outcome.message }
  if (outcome.status === 'already_finished' && run) {
    const label = { succeeded: '已完成', failed: '已失败', stopped: '已停止' }[run.status] ?? '已结束'
    return { kind: 'success', text: `MAA 任务${label}（${run.id}），无需再次停止。` }
  }
  if (outcome.status === 'not_running') return { kind: 'error', text: '当前没有正在执行的 MAA 任务。' }
  return { kind: 'error', text: outcome.message || '已发送停止请求，但尚未确认 MAA 进程退出，请查看运行状态。' }
}

export function formatRuntimeInstructionResult(result) {
  if (result.status === 'ok' && result.run) return JSON.stringify({ running: result.run })
  return result.message || JSON.stringify(result)
}

export function formatBackgroundResult(result) {
  return [
    `MAA 已开始执行（${result.runId}）。`,
    `计划：${result.planSummary}`,
    '任务在后台运行：确认面板会显示「执行中」和本地计时，需要中止时点击「停止任务」或输入 /maa stop；结束后点「查看执行记录」查看结果。',
    result.maintenanceWarning ?? '',
  ].filter(Boolean).join('\n')
}
