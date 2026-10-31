import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  applyRuntimeInstruction,
  completeTriggeredInstructions,
  parseMaaCallbackLine,
  parseRuntimeInstruction,
  processMaaCallback,
  startLogTail,
} from '../src/commands/runtime-instructions.js'
import { beginRun, clearRunStateForTest, finishRun, getRun } from '../src/commands/run-state.js'
import { startMaa } from '../src/runtime/runner.js'

async function fixture(taskTypes = ['Roguelike']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-runtime-instruction-'))
  const env = { DSH_MAA_CLI_STATE_DIR: root }
  const run = await beginRun({ purpose: 'test', taskTypes }, { env, now: Date.now() })
  return { root, env, run }
}

test('parses the common runtime phrases locally', () => {
  assert.deepEqual(parseRuntimeInstruction('现在停止'), { action: 'stop_now' })
  assert.deepEqual(parseRuntimeInstruction('这把肉鸽打完就停'), { action: 'stop_after_current' })
  assert.deepEqual(parseRuntimeInstruction('再打两局就停'), { action: 'stop_after_runs', count: 2 })
  assert.deepEqual(parseRuntimeInstruction('第五层 Boss 前停止'), { action: 'stop_before_boss', floor: 5 })
  assert.deepEqual(parseRuntimeInstruction('取消刚才的停止要求'), { action: 'cancel_stop' })
  assert.deepEqual(parseRuntimeInstruction('现在打到哪里了'), { action: 'status' })
  assert.deepEqual(parseRuntimeInstruction('接下来优先招结城理'), { action: 'prefer_recruit', operator: '结城理' })
  assert.throws(() => parseRuntimeInstruction('看着办'), /无法可靠识别/u)
})

test('stops after exactly the requested number of reliable settlement callbacks', async t => {
  const { root, env, run } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const applied = await applyRuntimeInstruction(run.id, { action: 'stop_after_runs', count: 2 }, { env, monitorAvailable: true })
  assert.equal(applied.status, 'applied')
  assert.equal(applied.instruction.params.targetCompleted, 2)
  const stopped = []
  const settlement = { event: 'SubTaskExtraInfo', what: 'RoguelikeSettlement', details: { floor: 3 } }
  assert.equal((await processMaaCallback(run.id, settlement, { env, stop: id => stopped.push(id) })).triggered, null)
  const second = await processMaaCallback(run.id, settlement, { env, stop: id => stopped.push(id) })
  assert.equal(second.triggered.status, 'triggered')
  assert.deepEqual(stopped, [applied.instruction.id])
  assert.equal((await getRun(run.id, { env })).progress.explorationsCompleted, 2)
  await completeTriggeredInstructions(run.id, { env })
  assert.equal((await getRun(run.id, { env })).instructions[0].status, 'completed')
})

test('boss-floor control triggers only on the exact pre-entry callback', async t => {
  const { root, env, run } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const applied = await applyRuntimeInstruction(run.id, { action: 'stop_before_boss', floor: 5 }, { env, monitorAvailable: true })
  let stopped = 0
  await processMaaCallback(run.id, { event: 'SubTaskStart', what: '', details: { task: 'StageDreadfulFoe-4' } }, { env, stop: () => { stopped++ } })
  assert.equal(stopped, 0)
  const result = await processMaaCallback(run.id, { event: 'SubTaskStart', what: '', details: { task: 'StageDreadfulFoe-5' } }, { env, stop: () => { stopped++ } })
  assert.equal(stopped, 1)
  assert.equal(result.triggered.id, applied.instruction.id)
})

test('a newer stop condition replaces old pending conditions and can be cancelled', async t => {
  const { root, env, run } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await applyRuntimeInstruction(run.id, { action: 'stop_after_current' }, { env, monitorAvailable: true })
  const second = await applyRuntimeInstruction(run.id, { action: 'stop_after_runs', count: 3 }, { env, monitorAvailable: true })
  let current = await getRun(run.id, { env })
  assert.equal(current.instructions.find(item => item.id === first.instruction.id).status, 'cancelled')
  assert.equal(current.instructions.find(item => item.id === second.instruction.id).status, 'applied')
  const cancelled = await applyRuntimeInstruction(run.id, { action: 'cancel_stop' }, { env })
  assert.equal(cancelled.status, 'cancelled')
  current = await getRun(run.id, { env })
  assert.equal(current.instructions.find(item => item.id === second.instruction.id).status, 'cancelled')
})

test('marks an applied condition not triggered when the run ends first', async t => {
  const { root, env, run } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await applyRuntimeInstruction(run.id, { action: 'stop_before_boss', floor: 5 }, { env, monitorAvailable: true })
  await finishRun(run.id, { status: 'succeeded', summary: '自然结束。' }, { env })
  await completeTriggeredInstructions(run.id, { env })
  const final = await getRun(run.id, { env })
  assert.equal(final.instructions[0].status, 'not_triggered')
  assert.match(final.instructions[0].message, /条件未触发/u)
})

test('does not pretend unsupported live changes were applied', async t => {
  const { root, env, run } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const recruit = await applyRuntimeInstruction(run.id, { action: 'prefer_recruit', operator: '结城理' }, { env, monitorAvailable: true })
  assert.equal(recruit.status, 'unsupported')
  assert.match(recruit.message, /未应用/u)
  assert.equal(recruit.instruction.status, 'unsupported')

  await clearRunStateForTest(env)
  const fight = await beginRun({ purpose: 'fight', taskTypes: ['Fight'] }, { env, now: Date.now() })
  const condition = await applyRuntimeInstruction(fight.id, { action: 'stop_after_current' }, { env, monitorAvailable: true })
  assert.equal(condition.status, 'unsupported')
})

test('parses and tails only callbacks appended after monitoring starts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-log-tail-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'asst.log')
  const old = '[2026] Assistant::append_callback | SubTaskExtraInfo {"what":"StageInfo","details":{"name":"old"}}\r\n'
  await writeFile(file, old)
  const callbacks = []
  const monitor = await startLogTail(file, line => {
    const parsed = parseMaaCallbackLine(line)
    if (parsed) callbacks.push(parsed)
  }, { intervalMs: 10 })
  t.after(() => monitor.stop())
  await appendFile(file, '[2026] Assistant::append_callback | SubTaskStart {"details":{"task":"StageDreadfulFoe-5"}}\r\n')
  await monitor.flush()
  assert.equal(callbacks.length, 1)
  assert.equal(callbacks[0].event, 'SubTaskStart')
  assert.equal(callbacks[0].details.task, 'StageDreadfulFoe-5')
})

test('accepts a condition while maa-cli is still running and really stops its process tree on trigger', { skip: process.platform !== 'win32' }, async t => {
  const { root, env, run } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const cliPath = path.join(root, 'slow-maa.cmd')
  const logFile = path.join(root, 'asst.log')
  await writeFile(cliPath, '@echo off\r\nping -n 30 127.0.0.1 > nul\r\nexit /b 0\r\n')
  await writeFile(logFile, '')
  const controller = new AbortController()
  const handle = startMaa(['run', 'Task', '--batch'], { cliPath, signal: controller.signal, hardTimeoutMs: 60_000 })
  const monitor = await startLogTail(logFile, async line => {
    const callback = parseMaaCallbackLine(line)
    if (callback) await processMaaCallback(run.id, callback, { env, stop: () => controller.abort() })
  }, { intervalMs: 10 })
  t.after(() => monitor.stop())

  const applied = await applyRuntimeInstruction(run.id, { action: 'stop_after_current' }, { env, monitorAvailable: true })
  assert.equal(applied.status, 'applied')
  await appendFile(logFile, '[2026] Assistant::append_callback | SubTaskExtraInfo {"what":"RoguelikeSettlement","details":{"floor":3}}\r\n')
  await assert.rejects(handle.done, error => error?.name === 'AbortError')
  await monitor.flush()
  await finishRun(run.id, { status: 'stopped', summary: '已停止。' }, { env })
  await completeTriggeredInstructions(run.id, { env })
  const final = await getRun(run.id, { env })
  assert.equal(final.status, 'stopped')
  assert.equal(final.progress.explorationsCompleted, 1)
  assert.equal(final.instructions[0].status, 'completed')
})
