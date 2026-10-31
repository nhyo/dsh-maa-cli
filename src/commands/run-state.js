import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'

const RUNS_VERSION = 1
const MAX_RUNS = 8
// A run that never reported back (DSH killed, machine slept, maa-cli hung) must
// not block the plugin forever. The MAA task itself is capped at 30 minutes, so
// one stray record older than this is treated as interrupted.
const STALE_MS = 40 * 60_000
const INSTRUCTION_LIMIT = 30
let stateMutation = Promise.resolve()

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
      taskTypes: Array.isArray(payload.taskTypes) ? payload.taskTypes.map(String).slice(0, 20) : [],
      startedAt: now,
      finishedAt: null,
      exitCode: null,
      summary: '',
      progress: emptyProgress(now),
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
    run.status = patch.status ?? 'finished'
    run.finishedAt = options.now ?? Date.now()
    if (Number.isInteger(patch.exitCode)) run.exitCode = patch.exitCode
    if (patch.summary !== undefined) run.summary = String(patch.summary ?? '').slice(0, 2000)
    return run
  })
}

// Marks a still-"running" record as interrupted, and optionally stops the
// maa-cli process tree that is running the generated task.
export async function stopRun(id, options = {}) {
  const env = options.env ?? process.env
  const run = (await readRunState(env)).runs.find(item => item.id === id)
  if (!run) return null
  const stopped = await finishRun(id, { status: 'stopped', summary: '已停止。' }, { env, now: options.now })
  if (options.reap !== false) await reapGeneratedTaskProcesses()
  return stopped
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
    finishedAt: Number.isFinite(finishedAt) && finishedAt > 0 ? new Date(finishedAt).toISOString() : '',
    durationMs,
    duration: formatDuration(durationMs),
    exitCode: run.exitCode,
    summary: run.summary,
    progress: { ...emptyProgress(startedAt), ...(run.progress ?? {}) },
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
