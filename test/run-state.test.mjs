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
  describeRunState,
  finishRun,
  finishInterruptedRun,
  readRunState,
  runStateFilePath,
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

test('the composer dock reads runs on demand instead of polling the command plane', async () => {
  const commandSource = await readFile(new URL('../src/commands/local-command.js', import.meta.url), 'utf8')
  assert.match(commandSource, /\{ kind: 'status' \}/u)
  assert.match(commandSource, /\/maa status/u)

  const clientSource = await readFile(new URL('../src/client/index.js', import.meta.url), 'utf8')
  // The dock needs the command runner injected, otherwise the on-demand record
  // read never has a transport and the panel falls back to a stale bar.
  assert.match(clientSource, /id: 'maa-confirm'[\s\S]*?execute: commandRunner\(ctx, sessionId\)/u)
  assert.match(clientSource, /\[\s*'maa_prepare_plan',\s*'maa_prepare_strategy',\s*'maa_prepare_note'\s*\]/u)
  // DSH echoes every `/maa ...` command into the conversation, so the dock must
  // never poll: each command runs only when the user asks for it.
  assert.match(clientSource, /function readStoredRun\(\)/u)
  assert.match(clientSource, /function readRunRecord\(execute\)/u)
  assert.match(clientSource, /function useRunClock\(active\)/u)
  assert.match(clientSource, /dsh\.maa\.run/u)
  assert.equal((clientSource.match(/execute\('\/maa status'\)/g) || []).length, 1)
  assert.equal((clientSource.match(/execute\('\/maa stop'\)/g) || []).length, 2)
  assert.match(clientSource, /onStart: function \(\) \{\s*rememberRun\(plan\.summary, plan\.code\)/u)
  assert.doesNotMatch(clientSource, /useRunSnapshot/u)
})
