const SAFE_RETRY_TASKS = new Set(['Depot', 'OperBox'])
export const MAX_RECOVERY_RETRIES = 2

export function diagnoseExecutionFailure(input = {}) {
  const callbacks = Array.isArray(input.callbacks) ? input.callbacks : []
  const error = input.error
  if (error?.name === 'AbortError') return diagnosis('stopped', 'confirmed', '任务由用户或运行时停止条件终止。', false, 'none')

  for (const callback of [...callbacks].reverse()) {
    const what = String(callback.what ?? callback.body?.what ?? '')
    const event = String(callback.event ?? '')
    if (event === 'ConnectionInfo' && ['ConnectFailed', 'Disconnect'].includes(what)) {
      return diagnosis('adb_connection', 'confirmed', `MaaCore 回调确认连接失败：${what}${callback.body?.why ? `（${callback.body.why}）` : ''}`, true, 'probe_adb')
    }
    if (event === 'ConnectionInfo' && what === 'ScreencapFailed') {
      return diagnosis('adb_capture', 'confirmed', 'MaaCore 回调确认截图失败，ADB 或模拟器可能中断。', true, 'probe_adb')
    }
    if (event === 'TaskChainError') {
      const kind = String(callback.details?.error ?? 'UnknownException')
      const restart = ['OutOfMemory', 'GpuDeviceRemoved'].includes(kind)
      return diagnosis(restart ? 'core_restart_required' : 'taskchain_exception', 'confirmed', `MaaCore 任务链异常：${kind}`, false, 'ask_user')
    }
    if (event === 'SubTaskError' && what === 'UnknownTask') {
      return diagnosis('resource_mismatch', 'confirmed', `MaaCore 不认识任务资源：${(callback.details?.tasks ?? []).join('、') || '未知任务'}`, false, 'update_runtime')
    }
    if (event === 'SubTaskError') {
      return diagnosis('subtask_failed', 'confirmed', `MaaCore 子任务失败：${what || callback.details?.task || '未知原因'}`, false, 'ask_user')
    }
    if (event === 'InitFailed') return diagnosis('initialization', 'confirmed', `MaaCore 初始化失败：${what || callback.body?.why || '未知原因'}`, false, 'doctor')
  }

  const text = `${input.result?.stdout ?? ''}\n${input.result?.stderr ?? ''}\n${error?.message ?? ''}`
  if (/(?:device\s+offline|no\s+devices|connect(?:ion)?\s+failed|adb[^\n]*(?:failed|error|closed))/iu.test(text)) {
    return diagnosis('adb_connection', 'inferred', '日志文本疑似 ADB 连接失败；没有收到结构化连接失败回调。', true, 'probe_adb')
  }
  if (/Failed to convert difficulty text to number/iu.test(text)) {
    return diagnosis('recognition', 'confirmed', 'MAA 无法把识别到的难度文本转换为数字。', false, 'ask_user')
  }
  if (input.result?.exitCode !== undefined && input.result.exitCode !== 0) {
    return diagnosis('process_exit', 'confirmed', `maa-cli 进程退出码 ${input.result.exitCode}。`, false, 'doctor')
  }
  if (/\bFailed\b/iu.test(text)) return diagnosis('task_failed', 'confirmed', 'MAA 摘要报告任务失败。', false, 'ask_user')
  return diagnosis('unknown', 'inferred', '没有足够的结构化信息确认失败原因。', false, 'ask_user')
}

export function decideRecovery({ diagnosis: failure, document, attempt = 0, checkpoints = [], emulator } = {}) {
  const taskTypes = (document?.tasks ?? []).map(task => task?.type).filter(Boolean)
  const readOnly = taskTypes.length > 0 && taskTypes.every(type => SAFE_RETRY_TASKS.has(type))
  const completed = checkpoints.some(item => item?.status === 'completed')
  if (!failure || !failure.retryable) return stopDecision('故障类型不允许自动重试。')
  if (!readOnly) return stopDecision('计划包含可能消耗资源或改变游戏状态的步骤，不能自动重试。')
  if (completed) return stopDecision('已有任务链完成检查点，重复执行可能造成重复操作。')
  if (attempt >= MAX_RECOVERY_RETRIES) return stopDecision(`已达到自动重试上限 ${MAX_RECOVERY_RETRIES} 次。`)
  if (emulator && emulator.ok === false) return stopDecision('ADB 端口仍不可达，需要用户启动模拟器或恢复 ADB。')
  const delayMs = attempt === 0 ? 1_000 : 3_000
  return { action: 'retry', safe: true, delayMs, reason: `只读扫描可安全重试，将在 ${delayMs / 1000} 秒后进行第 ${attempt + 1} 次重试。` }
}

export function callbackCheckpoint(callback) {
  if (!['TaskChainStart', 'TaskChainCompleted', 'TaskChainError', 'TaskChainStopped'].includes(callback?.event)) return null
  const status = callback.event === 'TaskChainStart' ? 'started'
    : callback.event === 'TaskChainCompleted' ? 'completed'
      : callback.event === 'TaskChainStopped' ? 'stopped' : 'failed'
  return { taskchain: callback.body?.taskchain ?? '', taskId: callback.body?.taskid, status }
}

export function isExecutionFailure(result) {
  if (!result || result.exitCode !== 0) return true
  return /^\[[^\]]+\]\s+Failed\s*$/imu.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}

function diagnosis(category, confidence, reason, retryable, suggestedAction) {
  return { category, confidence, reason, retryable, suggestedAction }
}

function stopDecision(reason) {
  return { action: 'ask_user', safe: false, delayMs: 0, reason }
}
