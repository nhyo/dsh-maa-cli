import assert from 'node:assert/strict'
import test from 'node:test'
import { callbackCheckpoint, decideRecovery, diagnoseExecutionFailure, isExecutionFailure } from '../src/agent/recovery-manager.js'

test('classifies confirmed and inferred failures separately', () => {
  const confirmed = diagnoseExecutionFailure({ callbacks: [{ event: 'ConnectionInfo', what: 'Disconnect', body: { why: 'offline' } }] })
  assert.equal(confirmed.category, 'adb_connection')
  assert.equal(confirmed.confidence, 'confirmed')
  assert.equal(confirmed.retryable, true)
  const inferred = diagnoseExecutionFailure({ result: { exitCode: 1, stderr: 'adb: device offline' } })
  assert.equal(inferred.category, 'adb_connection')
  assert.equal(inferred.confidence, 'inferred')
  const unknown = diagnoseExecutionFailure({ result: { exitCode: 0, stdout: '' } })
  assert.equal(unknown.category, 'unknown')
})

test('allows bounded retry only for untouched read-only scans', () => {
  const failure = { retryable: true }
  assert.equal(decideRecovery({ diagnosis: failure, document: { tasks: [{ type: 'Depot' }] }, attempt: 0, checkpoints: [], emulator: { ok: true } }).action, 'retry')
  assert.equal(decideRecovery({ diagnosis: failure, document: { tasks: [{ type: 'Fight' }] }, attempt: 0, checkpoints: [] }).action, 'ask_user')
  assert.equal(decideRecovery({ diagnosis: failure, document: { tasks: [{ type: 'Depot' }] }, attempt: 0, checkpoints: [{ status: 'completed' }] }).action, 'ask_user')
  assert.equal(decideRecovery({ diagnosis: failure, document: { tasks: [{ type: 'Depot' }] }, attempt: 2, checkpoints: [] }).action, 'ask_user')
  assert.equal(decideRecovery({ diagnosis: failure, document: { tasks: [{ type: 'OperBox' }] }, attempt: 0, checkpoints: [], emulator: { ok: false } }).action, 'ask_user')
})

test('extracts task-chain checkpoints and process failure summaries', () => {
  assert.deepEqual(callbackCheckpoint({ event: 'TaskChainCompleted', body: { taskchain: 'Depot', taskid: 7 } }), { taskchain: 'Depot', taskId: 7, status: 'completed' })
  assert.equal(callbackCheckpoint({ event: 'SubTaskCompleted' }), null)
  assert.equal(isExecutionFailure({ exitCode: 0, stdout: '[Depot] Completed' }), false)
  assert.equal(isExecutionFailure({ exitCode: 0, stdout: '[Depot] Failed' }), true)
})
