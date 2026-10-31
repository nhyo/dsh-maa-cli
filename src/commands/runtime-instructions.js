import { open, stat } from 'node:fs/promises'
import { addRunInstruction, cancelPendingStopInstructions, getRun, updateRunInstruction, updateRunProgress } from './run-state.js'

const STOP_TYPES = new Set(['stop_now', 'stop_after_current', 'stop_after_runs', 'stop_before_boss'])
const CHINESE_NUMBER = new Map([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
])

export function parseRuntimeInstruction(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error('运行时指令不能为空。')
  if (/^(?:现在|立即|马上)?(?:停止|停下|终止)(?:任务)?[。！!]?$/u.test(text)) return { action: 'stop_now' }
  if (/^(?:这|本)(?:把|局)(?:肉鸽|探索)?打完(?:就|后)?停(?:止)?[。！!]?$/u.test(text)) return { action: 'stop_after_current' }
  const runs = text.match(/^再打(\d+|[一二两三四五六七八九十])(?:把|局|次)(?:就|后)?停(?:止)?[。！!]?$/u)
  if (runs) return { action: 'stop_after_runs', count: parseSmallNumber(runs[1]) }
  const boss = text.match(/^(?:在)?第(\d+|[一二两三四五六七八九十])层\s*(?:Boss|BOSS|boss|首领)(?:战)?\s*前停(?:止)?[。！!]?$/u)
  if (boss) return { action: 'stop_before_boss', floor: parseSmallNumber(boss[1]) }
  if (/^(?:取消|撤销)(?:刚才的|之前的|尚未触发的)?停止(?:要求|条件|指令)?[。！!]?$/u.test(text)) return { action: 'cancel_stop' }
  if (/^(?:现在)?(?:打|运行|进行)?到哪里了[？?]?$/u.test(text) || /^(?:查询|查看)?(?:实时)?进度[？?]?$/u.test(text)) return { action: 'status' }
  const recruit = text.match(/^(?:接下来|之后|后面)(?:请)?优先(?:招募|招|抓|拿|选)\s*(.{1,20}?)[。！!]?$/u)
  if (recruit) return { action: 'prefer_recruit', operator: recruit[1].trim() }
  throw new Error('无法可靠识别该运行时指令；请使用“现在停止”“这把肉鸽打完就停”“第五层 Boss 前停止”“再打两局就停”“取消刚才的停止要求”或“现在打到哪里了”。')
}

export async function applyRuntimeInstruction(runId, request, options = {}) {
  const run = await getRun(runId, options)
  if (!run || run.status !== 'running') return { status: 'not_running', message: '当前没有正在执行的 MAA 任务。' }
  const action = String(request.action ?? '')
  if (action === 'status') return { status: 'ok', run }
  if (action === 'cancel_stop') {
    const cancelled = await cancelPendingStopInstructions(runId, options)
    return {
      status: cancelled.length > 0 ? 'cancelled' : 'nothing_to_cancel',
      cancelled,
      message: cancelled.length > 0 ? `已取消 ${cancelled.length} 条尚未触发的停止条件。` : '没有尚未触发的停止条件可取消。',
    }
  }
  if (action === 'prefer_recruit') {
    const operator = String(request.operator ?? '').trim()
    if (operator === '') throw new Error('必须提供要优先招募的干员。')
    const message = '当前任务由独立 maa-cli 进程持有 MaaCore 句柄，DSH 无法可靠修改正在运行的招募参数；该要求未应用，也未写入长期策略记忆。请在下一次计划的备注中设置。'
    const instruction = await addRunInstruction(runId, { type: action, status: 'unsupported', params: { operator }, message }, options)
    return { status: 'unsupported', instruction, message }
  }
  if (['stop_after_current', 'stop_after_runs', 'stop_before_boss'].includes(action) && !run.taskTypes?.includes('Roguelike')) {
    const message = '该条件只适用于正在执行的肉鸽任务；当前任务不是肉鸽，未应用。'
    const instruction = await addRunInstruction(runId, { type: action, status: 'unsupported', params: {}, message }, options)
    return { status: 'unsupported', instruction, message }
  }
  if (!STOP_TYPES.has(action)) throw new Error(`不支持的运行时动作：${action}`)
  const params = {}
  if (action === 'stop_after_current') params.targetCompleted = Number(run.progress?.explorationsCompleted ?? 0) + 1
  if (action === 'stop_after_runs') {
    const count = Number(request.count)
    if (!Number.isInteger(count) || count < 1 || count > 99) throw new Error('剩余局数必须在 1–99 之间。')
    params.count = count
    params.targetCompleted = Number(run.progress?.explorationsCompleted ?? 0) + count
  }
  if (action === 'stop_before_boss') {
    const floor = Number(request.floor)
    if (!Number.isInteger(floor) || floor < 1 || floor > 99) throw new Error('Boss 层数必须在 1–99 之间。')
    params.floor = floor
  }
  // A newer stop condition replaces older pending stop conditions. Immediate
  // stop is recorded too, so received/applied/triggered/completed stay distinct.
  await cancelPendingStopInstructions(runId, options)
  const instruction = await addRunInstruction(runId, {
    type: action,
    status: options.monitorAvailable === false ? 'received' : 'applied',
    params,
    message: instructionMessage(action, params, options.monitorAvailable !== false),
  }, options)
  if (options.monitorAvailable === false && action !== 'stop_now') {
    return { status: 'received_not_applied', instruction, message: instruction.message }
  }
  if (action === 'stop_now') {
    await updateRunInstruction(runId, instruction.id, { status: 'triggered', message: '立即停止条件已触发，正在终止当前 MAA 进程树。' }, options)
    options.stop?.(instruction.id)
    return { status: 'triggered', instruction: await getInstruction(runId, instruction.id, options), message: '立即停止指令已触发，正在等待 MAA 进程结束。' }
  }
  return { status: 'applied', instruction, message: instruction.message }
}

export async function processMaaCallback(runId, callback, options = {}) {
  const run = await getRun(runId, options)
  if (!run || run.status !== 'running') return { progress: null, triggered: null }
  const progress = { ...(run.progress ?? {}) }
  const what = String(callback.what ?? '')
  const details = callback.details && typeof callback.details === 'object' ? callback.details : {}
  let relevant = false
  if (what === 'StageInfo' && typeof details.name === 'string' && details.name.trim()) {
    progress.stage = details.name.trim()
    relevant = true
  }
  if (what === 'BlackFlowMapSummary' && details.floor_from_ocr === true && Number.isInteger(details.floor)) {
    progress.floor = details.floor
    progress.floorReliable = true
    relevant = true
  }
  if (what === 'RoguelikeSettlement') {
    progress.explorationsCompleted = Number(progress.explorationsCompleted ?? 0) + 1
    progress.lastSettlementFloor = Number.isInteger(details.floor) ? details.floor : null
    progress.floor = null
    progress.floorReliable = false
    progress.stage = ''
    relevant = true
  }
  if (relevant) {
    progress.lastEvent = what
    progress.lastEventAt = options.now ?? Date.now()
    progress.updatedAt = progress.lastEventAt
    await updateRunProgress(runId, progress, options)
  }

  const refreshed = await getRun(runId, options)
  const pending = (refreshed?.instructions ?? []).filter(item => item.status === 'applied' && STOP_TYPES.has(item.type))
  let trigger = null
  if (what === 'RoguelikeSettlement') {
    const completed = Number(refreshed?.progress?.explorationsCompleted ?? 0)
    trigger = pending.find(item => ['stop_after_current', 'stop_after_runs'].includes(item.type) && completed >= Number(item.params?.targetCompleted))
  }
  if (callback.event === 'SubTaskStart' && typeof details.task === 'string') {
    trigger = pending.find(item => item.type === 'stop_before_boss' && details.task === `StageDreadfulFoe-${item.params?.floor}`) ?? trigger
  }
  if (!trigger) return { progress: refreshed?.progress ?? null, triggered: null }
  const message = trigger.type === 'stop_before_boss'
    ? `已从 MAA 回调确认即将进入第 ${trigger.params.floor} 层 Boss 节点，停止条件已触发。`
    : `已从 MAA 结算回调确认完成 ${refreshed.progress.explorationsCompleted} 局探索，停止条件已触发。`
  const changed = await updateRunInstruction(runId, trigger.id, { status: 'triggered', message }, { ...options, expectedStatuses: ['applied'] })
  if (!changed) return { progress: refreshed.progress, triggered: null }
  options.stop?.(trigger.id)
  return { progress: refreshed.progress, triggered: await getInstruction(runId, trigger.id, options) }
}

export async function completeTriggeredInstructions(runId, options = {}) {
  const run = await getRun(runId, options)
  const completed = []
  for (const entry of run?.instructions ?? []) {
    if (!['triggered', 'received', 'applied'].includes(entry.status)) continue
    const patch = entry.status === 'triggered'
      ? { status: 'completed', message: `${entry.message} MAA 进程已结束。` }
      : { status: 'not_triggered', message: `${entry.message} 当前 MAA 进程已结束，条件未触发。` }
    const changed = await updateRunInstruction(runId, entry.id, patch, options)
    if (changed) completed.push(changed)
  }
  return completed
}

export function parseMaaCallbackLine(line) {
  const match = String(line ?? '').match(/Assistant::append_callback\s*\|\s*([A-Za-z]+)\s+(\{.*\})\s*$/u)
  if (!match) return null
  try {
    const body = JSON.parse(match[2])
    return { event: match[1], what: body.what ?? '', details: body.details ?? {}, body }
  } catch {
    return null
  }
}

export async function startLogTail(file, onLine, options = {}) {
  let offset = await fileSize(file)
  let carry = ''
  let stopped = false
  let polling = false
  const intervalMs = options.intervalMs ?? 100
  const poll = async () => {
    if (stopped || polling) return
    polling = true
    try {
      const size = await fileSize(file)
      if (size < offset) { offset = 0; carry = '' }
      if (size <= offset) return
      const handle = await open(file, 'r')
      try {
        const buffer = Buffer.alloc(size - offset)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        offset += bytesRead
        const text = carry + buffer.subarray(0, bytesRead).toString('utf8')
        const lines = text.split(/\r?\n/u)
        carry = lines.pop() ?? ''
        for (const line of lines) await onLine(line)
      } finally {
        await handle.close()
      }
    } catch {
      // The log may be rotated or not created yet. The next poll retries.
    } finally {
      polling = false
    }
  }
  const timer = setInterval(() => { void poll() }, intervalMs)
  timer.unref?.()
  return {
    stop() { stopped = true; clearInterval(timer) },
    async flush() { await poll() },
  }
}

function parseSmallNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value)
  return CHINESE_NUMBER.get(value)
}

function instructionMessage(action, params, applied) {
  const suffix = applied ? '已应用，等待可靠的 MAA 回调触发。' : '已接收，但当前 DSH 进程没有该任务的控制句柄，未应用。'
  if (action === 'stop_now') return '已接收立即停止要求。'
  if (action === 'stop_after_current') return `当前探索结算后停止：${suffix}`
  if (action === 'stop_after_runs') return `再完成 ${params.count} 局探索后停止：${suffix}`
  return `在第 ${params.floor} 层 Boss 战前停止：${suffix}只有出现精确的 StageDreadfulFoe-${params.floor} 回调才会触发。`
}

async function getInstruction(runId, instructionId, options) {
  return (await getRun(runId, options))?.instructions?.find(item => item.id === instructionId) ?? null
}

async function fileSize(file) {
  try { return (await stat(file)).size } catch { return 0 }
}
