import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'

const RUNS_VERSION = 1
const MAX_RUNS = 8
// The runner has a six-hour hard ceiling. Keep the persisted lock slightly
// longer so a healthy long roguelike run cannot be mistaken for an orphan and
// started a second time. Plugin startup performs an explicit orphan audit.
const STALE_MS = 7 * 60 * 60_000
const INSTRUCTION_LIMIT = 30
let stateMutation = Promise.resolve()
const stopMutations = new Map()

export { STALE_MS }

export function runStateFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'runs.json')
}

export async function readRunState(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(runStateFilePath(env), 'utf8'))
    if (parsed?.version !== RUNS_VERSION || !Array.isArray(parsed.runs)) return emptyRunState()
    return { version: RUNS_VERSION, runs: parsed.runs.filter(item => item && typeof item === 'object' && item.id) }
  } catch {
    return emptyRunState()
  }
}

async function writeRunState(state, env) {
  const file = runStateFilePath(env)
  await mkdir(path.dirname(file), { recursive: true })
  const payload = `${JSON.stringify({ version: RUNS_VERSION, runs: state.runs }, null, 2)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, file)
  } catch {
    await writeFile(file, payload, 'utf8').catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function mutateRunState(env, mutate) {
  const operation = stateMutation.then(async () => {
    const state = await readRunState(env)
    const value = await mutate(state)
    await writeRunState(state, env)
    return value
  })
  stateMutation = operation.catch(() => {})
  return operation
}

// `stopRequestedAt` is null until a stop is requested. Number(null) is 0 and
// therefore "finite", which used to make every running record look like it was
// already stopping (the panel then disabled its stop button for good).
export function hasStopRequest(run) {
  const value = run?.stopRequestedAt
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function isRunLive(run, now = Date.now()) {
  if (run?.status !== 'running') return false
  const startedAt = Number(run.startedAt)
  if (!Number.isFinite(startedAt)) return false
  return now - startedAt < STALE_MS
}

export async function activeRun(options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const state = await readRunState(env)
  return state.runs.find(run => isRunLive(run, now)) ?? null
}

export async function getRun(id, options = {}) {
  const state = await readRunState(options.env ?? process.env)
  return state.runs.find(run => run.id === id) ?? null
}

export async function beginRun(payload, options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  return await mutateRunState(env, state => {
    const running = state.runs.find(run => isRunLive(run, now))
    if (running) {
      const error = new Error(`MAA 任务正在执行中（${running.purpose || running.confirmationCode || running.id}），完成前不接受新任务。`)
      error.code = 'MAA_RUN_ACTIVE'
      throw error
    }
    const run = {
      id: `RUN-${randomBytes(4).toString('hex').toUpperCase()}`,
      status: 'running',
      purpose: String(payload.purpose ?? '').slice(0, 200),
      planSummary: String(payload.planSummary ?? '').slice(0, 4000),
      confirmationCode: String(payload.confirmationCode ?? ''),
      sessionId: String(payload.sessionId ?? ''),
      // The plugin host that owns the child process, and the child's root pid.
      // Stop and restart audits use both so they never touch a process that
      // belongs to another DSH instance or to a user-launched MAA.
      ownerPid: Number.isInteger(payload.ownerPid) ? payload.ownerPid : process.pid,
      pid: null,
      stopError: '',
      taskTypes: Array.isArray(payload.taskTypes) ? payload.taskTypes.map(String).slice(0, 20) : [],
      startedAt: now,
      stopRequestedAt: null,
      finishedAt: null,
      exitCode: null,
      summary: '',
      progress: emptyProgress(now),
      recovery: emptyRecovery(),
      checkpoints: [],
      instructions: [],
    }
    state.runs = [run, ...state.runs].slice(0, MAX_RUNS)
    return run
  })
}

export async function finishRun(id, patch = {}, options = {}) {
  const env = options.env ?? process.env
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === id)
    if (!run) return null
    // The first terminal result wins: a late settlement must not turn a
    // recorded "stopped" into "failed", or the other way round.
    if (run.status !== 'running' && options.overwrite !== true) return run
    run.status = patch.status ?? 'finished'
    run.stopError = ''
    run.finishedAt = options.now ?? Date.now()
    if (Number.isInteger(patch.exitCode)) run.exitCode = patch.exitCode
    if (patch.summary !== undefined) run.summary = String(patch.summary ?? '').slice(0, 2000)
    return run
  })
}

export async function setRunProcess(id, pid, options = {}) {
  const env = options.env ?? process.env
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === id)
    if (!run) return null
    run.pid = Number.isInteger(pid) ? pid : null
    return run
  })
}

// A stop attempt that could not confirm process exit releases the "stopping"
// flag again so the control stays usable, and records why it failed.
export async function clearRunStopping(id, reason = '', options = {}) {
  const env = options.env ?? process.env
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === id)
    if (!run || run.status !== 'running') return run ?? null
    run.stopRequestedAt = null
    run.stopError = String(reason ?? '').slice(0, 500)
    return run
  })
}

export async function markRunStopping(id, options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === id)
    if (!run || run.status !== 'running') return run ?? null
    if (!hasStopRequest(run)) run.stopRequestedAt = now
    run.stopError = ''
    return run
  })
}

// Marks a still-"running" record as stopped after its process tree has been
// terminated. Used for records whose process is NOT owned by this plugin
// process (DSH restarted while maa-cli kept running). The reaper only targets
// the recorded process tree; a record without a pid (written by an older
// version) falls back to the narrow "dsh-generated" command-line match.
export async function stopRun(id, options = {}) {
  const existing = stopMutations.get(id)
  if (existing) return await existing
  const operation = (async () => {
    const env = options.env ?? process.env
    const run = (await readRunState(env)).runs.find(item => item.id === id)
    if (!run) return null
    if (run.status !== 'running') return run
    await markRunStopping(id, { env, now: options.now })
    if (options.reap !== false) {
      const reap = typeof options.reapProcess === 'function'
        ? options.reapProcess
        : () => Number.isInteger(run.pid) ? reapRunProcessTree(run.pid) : reapGeneratedTaskProcesses()
      let outcome
      try { outcome = await reap(run) } catch (error) { outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) } }
      if (outcome && outcome.ok === false) {
        await clearRunStopping(id, outcome.detail || '无法确认 MAA 进程已退出。', { env })
        const error = new Error(`停止失败：${outcome.detail || '无法确认 MAA 进程已退出。'}任务记录保持“执行中”，可以重试停止。`)
        error.code = 'MAA_STOP_FAILED'
        throw error
      }
    }
    // Persist "stopped" only after the owned/recovered process has actually
    // been terminated. This keeps the panel from claiming cleanup finished.
    return await finishRun(id, { status: 'stopped', summary: options.summary ?? '已停止。' }, { env, now: options.now })
  })()
  stopMutations.set(id, operation)
  try { return await operation } finally { if (stopMutations.get(id) === operation) stopMutations.delete(id) }
}

export async function addRunInstruction(id, instruction, options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === id)
    if (!run) return null
    const entry = {
      id: `INS-${randomBytes(4).toString('hex').toUpperCase()}`,
      type: String(instruction.type ?? ''),
      status: String(instruction.status ?? 'received'),
      params: instruction.params && typeof instruction.params === 'object' ? instruction.params : {},
      message: String(instruction.message ?? '').slice(0, 1000),
      createdAt: now,
      appliedAt: null,
      triggeredAt: null,
      completedAt: null,
      cancelledAt: null,
    }
    if (entry.status === 'applied') entry.appliedAt = now
    if (entry.status === 'unsupported') entry.completedAt = now
    run.instructions = [entry, ...(Array.isArray(run.instructions) ? run.instructions : [])].slice(0, INSTRUCTION_LIMIT)
    return entry
  })
}

export async function updateRunInstruction(runId, instructionId, patch = {}, options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === runId)
    const entry = run?.instructions?.find(item => item.id === instructionId)
    if (!entry) return null
    if (Array.isArray(options.expectedStatuses) && !options.expectedStatuses.includes(entry.status)) return null
    if (patch.status) {
      entry.status = String(patch.status)
      if (entry.status === 'applied' && !entry.appliedAt) entry.appliedAt = now
      if (entry.status === 'triggered' && !entry.triggeredAt) entry.triggeredAt = now
      if (entry.status === 'completed' && !entry.completedAt) entry.completedAt = now
      if (entry.status === 'not_triggered' && !entry.completedAt) entry.completedAt = now
      if (entry.status === 'cancelled' && !entry.cancelledAt) entry.cancelledAt = now
    }
    if (patch.message !== undefined) entry.message = String(patch.message ?? '').slice(0, 1000)
    return entry
  })
}

export async function cancelPendingStopInstructions(runId, options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === runId)
    if (!run) return []
    const cancelled = []
    for (const entry of run.instructions ?? []) {
      if (!entry.type.startsWith('stop_') || !['received', 'applied'].includes(entry.status)) continue
      entry.status = 'cancelled'
      entry.cancelledAt = now
      entry.message = '用户已取消该停止条件。'
      cancelled.push(entry)
    }
    return cancelled
  })
}

export async function updateRunProgress(runId, patch = {}, options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === runId)
    if (!run) return null
    run.progress = { ...emptyProgress(run.startedAt), ...(run.progress ?? {}), ...patch, updatedAt: now }
    return run.progress
  })
}

export async function updateRunRecovery(runId, patch = {}, options = {}) {
  const env = options.env ?? process.env
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === runId)
    if (!run) return null
    run.recovery = { ...emptyRecovery(), ...(run.recovery ?? {}), ...patch }
    if (patch.historyEntry) {
      const { historyEntry: _ignored, ...clean } = run.recovery
      run.recovery = clean
      run.recovery.history = [...(run.recovery.history ?? []), patch.historyEntry].slice(-20)
    }
    return run.recovery
  })
}

export async function addRunCheckpoint(runId, checkpoint, options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  return await mutateRunState(env, state => {
    const run = state.runs.find(item => item.id === runId)
    if (!run) return null
    const entry = {
      taskchain: String(checkpoint.taskchain ?? ''),
      status: String(checkpoint.status ?? ''),
      taskId: Number.isInteger(checkpoint.taskId) ? checkpoint.taskId : null,
      at: now,
    }
    run.checkpoints = [...(run.checkpoints ?? []), entry].slice(-100)
    return entry
  })
}

export function summarizeRun(run, now = Date.now()) {
  const startedAt = Number(run.startedAt)
  const finishedAt = Number(run.finishedAt)
  const end = Number.isFinite(finishedAt) && finishedAt > 0 ? finishedAt : now
  const durationMs = Number.isFinite(startedAt) ? Math.max(0, end - startedAt) : 0
  return {
    id: run.id,
    status: run.status,
    purpose: run.purpose,
    planSummary: run.planSummary,
    confirmationCode: run.confirmationCode,
    taskTypes: Array.isArray(run.taskTypes) ? run.taskTypes : [],
    startedAt: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : '',
    sessionId: String(run.sessionId ?? ''),
    stopError: String(run.stopError ?? ''),
    stopping: run.status === 'running' && hasStopRequest(run),
    finishedAt: Number.isFinite(finishedAt) && finishedAt > 0 ? new Date(finishedAt).toISOString() : '',
    durationMs,
    duration: formatDuration(durationMs),
    exitCode: run.exitCode,
    summary: run.summary,
    progress: { ...emptyProgress(startedAt), ...(run.progress ?? {}) },
    recovery: { ...emptyRecovery(), ...(run.recovery ?? {}) },
    checkpoints: Array.isArray(run.checkpoints) ? run.checkpoints : [],
    instructions: Array.isArray(run.instructions) ? run.instructions : [],
  }
}

export async function describeRunState(options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const state = await readRunState(env)
  const running = state.runs.find(run => isRunLive(run, now)) ?? null
  const interrupted = state.runs.find(run => run.status === 'running' && !isRunLive(run, now)) ?? null
  return {
    running: running ? summarizeRun(running, now) : null,
    interrupted: interrupted ? summarizeRun(interrupted, now) : null,
    recent: state.runs.filter(run => run !== running && run !== interrupted).slice(0, 5).map(run => summarizeRun(run, now)),
    serverTime: new Date(now).toISOString(),
  }
}

function emptyRunState() {
  return { version: RUNS_VERSION, runs: [] }
}

function emptyProgress(now) {
  return {
    explorationsCompleted: 0,
    floor: null,
    floorReliable: false,
    stage: '',
    lastEvent: '',
    lastEventAt: null,
    updatedAt: now,
  }
}

function emptyRecovery() {
  return { status: 'idle', attempt: 0, maxRetries: 2, diagnosis: null, needsUser: false, nextRetryAt: null, history: [] }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds} 秒`
  if (minutes < 60) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
}

/**
 * `maa run dsh-generated --batch` leaves a maa executable behind when DSH is
 * killed mid-run. Stop only processes whose command line names the generated
 * task: never the MAA GUI, the emulator, or an unrelated maa-cli invocation.
 */
export async function reapGeneratedTaskProcesses() {
  if (process.platform !== 'win32') return { killed: 0, pids: [] }
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*dsh-generated*' -and ($_.Name -eq 'maa.exe' -or $_.Name -eq 'maa-cli.exe') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $_.ProcessId } catch {} }"
  return await new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', () => resolve({ killed: 0, pids: [] }))
    child.on('close', () => {
      const pids = Buffer.concat(chunks).toString('utf8').split(/\r?\n/u).map(line => Number(line.trim())).filter(Number.isInteger)
      resolve({ killed: pids.length, pids })
    })
  })
}

/**
 * Terminate exactly one recorded process tree. On Windows the recorded pid is
 * the cmd.exe wrapper; the tree is resolved from Win32_Process parent links and
 * every member must still carry "dsh-generated" (or be the wrapper of such a
 * process) before it is touched, so a recycled pid can never hit an unrelated
 * program. Returns { ok, killed, pids, detail }.
 */
export async function reapRunProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true, killed: 0, pids: [], detail: '没有记录进程号。' }
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        try { process.kill(pid, 'SIGKILL') } catch (inner) {
          if (inner?.code !== 'ESRCH') return { ok: false, killed: 0, pids: [], detail: inner.message }
        }
      }
    }
    return { ok: true, killed: 1, pids: [pid], detail: '' }
  }
  // Collect the recorded tree through parent links (the wrapper may already be
  // gone while its maa child lives on), then stop only members whose own
  // command line names the generated task. A recycled pid that now belongs to
  // an unrelated program therefore matches nothing and is left alone.
  const script = [
    `$root = ${pid}`,
    '$all = @(Get-CimInstance Win32_Process)',
    "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
    '[void]$ids.Add($root)',
    'do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added)',
    "$owned = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.CommandLine -and $_.CommandLine -like '*dsh-generated*' })",
    "if ($owned.Count -eq 0) { 'NONE'; exit 0 }",
    '$failed = 0',
    "foreach ($p in $owned) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; 'KILLED ' + $p.ProcessId } catch { if (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue) { $failed++; 'FAILED ' + $p.ProcessId + ' ' + $_.Exception.Message } } }",
    'if ($failed -gt 0) { exit 3 }',
  ].join('\n')
  return await new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', error => resolve({ ok: false, killed: 0, pids: [], detail: `无法启动 PowerShell：${error.message}` }))
    child.on('close', code => {
      const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
      const pids = lines.filter(line => line.startsWith('KILLED ')).map(line => Number(line.slice(7))).filter(Number.isInteger)
      const failures = lines.filter(line => line.startsWith('FAILED '))
      if (code === 0) return resolve({ ok: true, killed: pids.length, pids, detail: lines.includes('NONE') ? '记录的进程已经退出。' : '' })
      resolve({ ok: false, killed: pids.length, pids, detail: failures.join('；') || `PowerShell 退出码 ${code}` })
    })
  })
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function clearRunStateForTest(env = process.env) {
  await rm(runStateFilePath(env), { force: true }).catch(() => {})
}

/**
 * A DSH restart can leave a record stuck in "running" even though the maa-cli
 * process is gone. The dock surfaces it as "已中断"; this closes it for good.
 */
export async function finishInterruptedRun(options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const state = await readRunState(env)
  const interrupted = state.runs.find(run => run.status === 'running' && !isRunLive(run, now))
  if (!interrupted) return null
  return await finishRun(interrupted.id, { status: 'stopped', summary: 'DSH 重启后已结束残留记录。' }, { env, now })
}
