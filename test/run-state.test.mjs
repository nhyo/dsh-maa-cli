import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  STALE_MS,
  activeRun,
  beginRun,
  clearRunStateForTest,
  clearRunStopping,
  describeRunState,
  finishRun,
  finishInterruptedRun,
  getRun,
  hasStopRequest,
  isProcessAlive,
  markRunStopping,
  readRunState,
  reapRunProcessTree,
  runStateFilePath,
  setRunProcess,
  stopRun,
  summarizeRun,
} from '../src/commands/run-state.js'

async function withStateDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-run-'))
  const env = { DSH_MAA_CLI_STATE_DIR: dir }
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return env
}

test('records a run, exposes it as live, then finishes it', async (t) => {
  const env = await withStateDir(t)
  const startedAt = 1_700_000_000_000
  const run = await beginRun({ purpose: '自定义任务', planSummary: '计划：执行一次', confirmationCode: 'MAA-123456' }, { env, now: startedAt })
  assert.match(run.id, /^RUN-[A-F0-9]{8}$/u)
  assert.equal(run.status, 'running')
  assert.equal(run.startedAt, startedAt)
  assert.equal(run.finishedAt, null)

  const live = await activeRun({ env, now: startedAt + 1000 })
  assert.equal(live.id, run.id)

  await finishRun(run.id, { status: 'succeeded', exitCode: 0, summary: 'MAA 执行完成。' }, { env, now: startedAt + 5000 })
  assert.equal(await activeRun({ env, now: startedAt + 6000 }), null)

  const state = await readRunState(env)
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].status, 'succeeded')
  assert.equal(state.runs[0].exitCode, 0)
  assert.equal(state.runs[0].finishedAt, startedAt + 5000)
  assert.equal(state.runs[0].summary, 'MAA 执行完成。')

  // The record is persisted, so a restarted DSH (a new process reading the same
  // state directory) still sees the recent execution.
  const onDisk = JSON.parse(await readFile(runStateFilePath(env), 'utf8'))
  assert.equal(onDisk.runs[0].id, run.id)
})

test('refuses to start a second run while one is live', async (t) => {
  const env = await withStateDir(t)
  const now = 1_700_000_100_000
  const first = await beginRun({ purpose: '第一个任务' }, { env, now })
  await assert.rejects(
    beginRun({ purpose: '第二个任务' }, { env, now: now + 1000 }),
    (error) => error.code === 'MAA_RUN_ACTIVE' && /MAA 任务正在执行中/u.test(error.message),
  )
  const state = await readRunState(env)
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].id, first.id)
})

test('treats a run older than the stale window as no longer live', async (t) => {
  const env = await withStateDir(t)
  const now = 1_700_000_200_000
  const run = await beginRun({ purpose: '卡住的任务' }, { env, now })
  assert.equal((await activeRun({ env, now: now + STALE_MS - 1 })).id, run.id)
  assert.equal(await activeRun({ env, now: now + STALE_MS + 1 }), null)

  const described = await describeRunState({ env, now: now + STALE_MS + 1 })
  assert.equal(described.running, null)
  assert.equal(described.interrupted.id, run.id)
  assert.equal(described.interrupted.status, 'running')
  assert.equal(described.interrupted.duration, summarizeRun(run, now + STALE_MS + 1).duration)
})

test('describeRunState keeps a bounded, newest-first history', async (t) => {
  const env = await withStateDir(t)
  const base = 1_700_000_300_000
  for (let index = 0; index < 10; index += 1) {
    const run = await beginRun({ purpose: `任务 ${index}` }, { env, now: base + index * 1000 })
    await finishRun(run.id, { status: 'succeeded', exitCode: 0, summary: '完成。' }, { env, now: base + index * 1000 + 10 })
  }
  const described = await describeRunState({ env, now: base + 20_000 })
  assert.equal(described.running, null)
  assert.equal(described.interrupted, null)
  assert.match(described.serverTime, /^\d{4}-\d{2}-\d{2}T/u)
  assert.ok(described.recent.length > 0 && described.recent.length <= 5)
  assert.equal(described.recent[0].id.startsWith('RUN-'), true)
  assert.equal(described.recent[0].purpose, '任务 9')
  // Newest first.
  assert.equal(described.recent[1].purpose, '任务 8')
})

test('stopRun marks the record stopped without spawning a reaper when asked', async (t) => {
  const env = await withStateDir(t)
  const now = 1_700_000_400_000
  const run = await beginRun({ purpose: '要停止的任务' }, { env, now })
  const stopped = await stopRun(run.id, { env, now: now + 2000, reap: false })
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.summary, '已停止。')
  assert.equal(await activeRun({ env, now: now + 3000 }), null)
})

test('stopRun stays running while cleanup is pending and deduplicates repeated stops', async (t) => {
  const env = await withStateDir(t)
  const now = 1_700_000_450_000
  const run = await beginRun({ purpose: '等待清理的任务' }, { env, now })
  let releaseCleanup
  let reapCount = 0
  let announceStarted
  const cleanupStarted = new Promise(resolve => { announceStarted = resolve })
  const cleanup = new Promise(resolve => { releaseCleanup = resolve })
  const reapProcess = async () => { reapCount += 1; announceStarted(); await cleanup; return { killed: 1, pids: [123] } }
  const first = stopRun(run.id, { env, now: now + 2000, reapProcess })
  await cleanupStarted
  const during = await describeRunState({ env, now: now + 2500 })
  assert.equal(during.running.id, run.id)
  assert.equal(during.running.stopping, true)
  const repeated = stopRun(run.id, { env, now: now + 3000, reapProcess })
  assert.equal(reapCount, 1)
  releaseCleanup()
  const [left, right] = await Promise.all([first, repeated])
  assert.equal(left.status, 'stopped')
  assert.equal(right.status, 'stopped')
  assert.equal(reapCount, 1)
  const after = await describeRunState({ env, now: now + 4000 })
  assert.equal(after.running, null)
  assert.equal(after.recent[0].status, 'stopped')
  assert.equal(after.recent[0].stopping, false)
})

test('finishInterruptedRun closes a stale record after a restart', async (t) => {
  const env = await withStateDir(t)
  const now = 1_700_000_500_000
  const run = await beginRun({ purpose: '重启前没跑完的任务' }, { env, now })
  const finished = await finishInterruptedRun({ env, now: now + STALE_MS + 1000 })
  assert.equal(finished.id, run.id)
  assert.equal(finished.status, 'stopped')
  const state = await readRunState(env)
  assert.equal(state.runs[0].status, 'stopped')
})

test('clearRunStateForTest removes the file', async (t) => {
  const env = await withStateDir(t)
  await beginRun({ purpose: '临时任务' }, { env, now: 1_700_000_600_000 })
  await clearRunStateForTest(env)
  const state = await readRunState(env)
  assert.deepEqual(state.runs, [])
})

test('the composer dock persists panel interaction state and never polls the command plane', async () => {
  const commandSource = await readFile(new URL('../src/commands/local-command.js', import.meta.url), 'utf8')
  assert.match(commandSource, /\{ kind: 'status' \}/u)
  assert.match(commandSource, /\/maa status/u)

  const clientSource = await readFile(new URL('../src/client/index.js', import.meta.url), 'utf8')
  // The dock needs the command runner injected, otherwise the on-demand record
  // read never has a transport and the panel falls back to a stale bar.
  assert.match(clientSource, /id: 'maa-confirm'[\s\S]*?execute: commandRunner\(ctx, sessionId\)/u)
  assert.match(clientSource, /\[\s*'maa_prepare_plan',\s*'maa_prepare_strategy',\s*'maa_prepare_note',\s*'maa_goal_manager',\s*'maa_workflow_manager'\s*\]/u)
  // DSH echoes every `/maa ...` command into the conversation, so the dock may
  // restore once on mount and after explicit gestures, but must never poll.
  assert.match(clientSource, /function readStoredRun\(sessionId\)/u)
  assert.match(clientSource, /function readRunRecord\(execute\)/u)
  assert.match(clientSource, /function useRunClock\(active\)/u)
  assert.match(clientSource, /dsh\.maa\.run/u)
  assert.equal((clientSource.match(/execute\('\/maa status'\)/g) || []).length, 1)
  assert.doesNotMatch(clientSource, /setInterval\([^)]*\/maa/u)
  // Stops always name the run (or launching code) they are meant for.
  assert.match(clientSource, /execute\(target \? '\/maa stop ' \+ target : '\/maa stop'\)/u)
  assert.match(clientSource, /React\.useEffect\(function \(\) \{ loadRecord\(\) \}, \[runs\]\)/u)
  assert.match(clientSource, /className: 'maa-stop-button'[\s\S]*?'停止任务'/u)
  assert.match(clientSource, /requestRunStop\(runs, plans, execute, true\)/u)
  assert.match(clientSource, /execute\('\/maa cancel ' \+ codeValue\)/u)
  assert.match(clientSource, /props\.collapsed \? '\+' : '\\u2212'/u)
  // Minimizing hides the body; it does not unmount it.
  assert.match(clientSource, /className: 'maa-dock-body', hidden: Boolean\(props\.collapsed\)/u)
  assert.match(clientSource, /placeholder: '输入运行时要求/u)
  assert.match(clientSource, /sendRuntimeInstruction\(runs, plans, execute, command\)/u)
  assert.doesNotMatch(clientSource, /'本局结束后停'|'取消停止条件'|'查看实时进度'/u)
  const variantStart = clientSource.indexOf('function switchPanelVariant(')
  const variantEnd = clientSource.indexOf('    // Unconfirmed panel edits survive a page refresh.', variantStart)
  assert.ok(variantStart >= 0 && variantEnd > variantStart)
  const switchPanelVariant = Function(`return (${clientSource.slice(variantStart, variantEnd)})`)()
  const panel = {
    type: 'Roguelike',
    preferenceVariants: {
      JieGarden: { theme: 'JieGarden', startsCount: 1, coreChar: '结城理', stopAtMaxLevel: true },
      Sami: { theme: 'Sami', startsCount: 8, coreChar: '提丰', stopAtMaxLevel: false },
    },
  }
  const jieDraft = { ...panel.preferenceVariants.JieGarden, investmentsCount: 31 }
  const toSami = switchPanelVariant(panel, jieDraft, { theme: 'Sami', startsCount: 9999 }, {})
  assert.equal(toSami.params.coreChar, '提丰')
  assert.equal(toSami.drafts.JieGarden.investmentsCount, 31)
  const samiDraft = { ...toSami.params, investmentsCount: 17 }
  const backToJie = switchPanelVariant(panel, samiDraft, { theme: 'JieGarden', startsCount: 9999 }, toSami.drafts)
  assert.equal(backToJie.params.coreChar, '结城理')
  assert.equal(backToJie.params.investmentsCount, 31)
  assert.doesNotMatch(clientSource, /useRunSnapshot/u)

  const viewStart = clientSource.indexOf("const PANEL_VIEW_STORAGE_KEY = 'dsh.maa.panel-view'")
  const viewEnd = clientSource.indexOf('    // end of panel view helpers', viewStart)
  assert.ok(viewStart >= 0 && viewEnd > viewStart)
  const storage = new Map()
  const fakeGlobal = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }
  const viewHelpers = Function('globalThis', `${clientSource.slice(viewStart, viewEnd)}; return { panelViewKey, readPanelCollapsed, writePanelCollapsed }`)(fakeGlobal)
  const planKey = viewHelpers.panelViewKey('plan', 'MAA-ABC123')
  const runKey = viewHelpers.panelViewKey('run', 'MAA-ABC123')
  assert.equal(viewHelpers.readPanelCollapsed(planKey), false)
  viewHelpers.writePanelCollapsed(planKey, true)
  assert.equal(viewHelpers.readPanelCollapsed(planKey), true)
  viewHelpers.writePanelCollapsed(planKey, false)
  assert.equal(viewHelpers.readPanelCollapsed(planKey), false)
  viewHelpers.writePanelCollapsed(planKey, true)
  viewHelpers.writePanelCollapsed(runKey, true)
  assert.equal(viewHelpers.readPanelCollapsed(planKey), true)
  assert.equal(viewHelpers.readPanelCollapsed(runKey), true)
  viewHelpers.writePanelCollapsed(runKey, false)
  assert.equal(viewHelpers.readPanelCollapsed(runKey), false)
})

test('a running record is not "stopping" until a stop is actually requested', async (t) => {
  const env = await withStateDir(t)
  const now = 1_700_000_700_000
  const run = await beginRun({ purpose: '新任务' }, { env, now })
  assert.equal(run.stopRequestedAt, null)
  // Number(null) === 0 is finite; this used to report every run as stopping
  // and disabled the panel's stop button.
  assert.equal((await describeRunState({ env, now: now + 1 })).running.stopping, false)
  assert.equal(hasStopRequest(run), false)
  await markRunStopping(run.id, { env, now: now + 5 })
  const marked = await getRun(run.id, { env })
  assert.equal(marked.stopRequestedAt, now + 5)
  assert.equal((await describeRunState({ env, now: now + 6 })).running.stopping, true)
  await clearRunStopping(run.id, '进程没有退出', { env })
  const cleared = await getRun(run.id, { env })
  assert.equal(cleared.stopRequestedAt, null)
  assert.equal(cleared.stopError, '进程没有退出')
  assert.equal((await describeRunState({ env, now: now + 7 })).running.stopError, '进程没有退出')
})

test('records the owning plugin process and the child pid; the first terminal status wins', async (t) => {
  const env = await withStateDir(t)
  const now = 1_700_000_800_000
  const run = await beginRun({ purpose: '记录进程', sessionId: 'session-a' }, { env, now })
  assert.equal(run.ownerPid, process.pid)
  await setRunProcess(run.id, 4242, { env })
  assert.equal((await getRun(run.id, { env })).pid, 4242)
  await finishRun(run.id, { status: 'stopped', summary: '已停止。' }, { env, now: now + 10 })
  await finishRun(run.id, { status: 'failed', summary: '迟到的失败结算' }, { env, now: now + 20 })
  const settled = await getRun(run.id, { env })
  assert.equal(settled.status, 'stopped')
  assert.equal(settled.summary, '已停止。')
  assert.equal(settled.finishedAt, now + 10)
})

test('a failed orphan stop keeps the record running with the reason, and a retry can finish it', async (t) => {
  const env = await withStateDir(t)
  const now = 1_700_000_900_000
  const run = await beginRun({ purpose: '残留任务' }, { env, now })
  await assert.rejects(
    stopRun(run.id, { env, now: now + 1, reapProcess: async () => ({ ok: false, detail: '拒绝访问' }) }),
    error => error.code === 'MAA_STOP_FAILED' && /拒绝访问/u.test(error.message),
  )
  const kept = await getRun(run.id, { env })
  assert.equal(kept.status, 'running')
  assert.equal(kept.stopRequestedAt, null)
  assert.match(kept.stopError, /拒绝访问/u)
  const stopped = await stopRun(run.id, { env, now: now + 2, reapProcess: async () => ({ ok: true }) })
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.stopError, '')
})

test('the targeted reaper only signals the recorded process tree', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = await import('node:child_process')
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const exited = new Promise(resolve => victim.once('exit', resolve))
  try {
    const result = await reapRunProcessTree(victim.pid)
    assert.equal(result.ok, true)
    await exited
    assert.equal(isProcessAlive(bystander.pid), true)
    // An already-gone tree is success, not an error.
    assert.equal((await reapRunProcessTree(victim.pid)).ok, true)
  } finally {
    try { process.kill(-bystander.pid, 'SIGKILL') } catch {}
  }
})
