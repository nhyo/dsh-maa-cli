import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertPlanCodeOpen,
  cancelPendingPlan,
  closedPlanStatus,
  consumeConfirmedPlan,
  consumePlanFromHumanGesture,
  peekPendingPlan,
  preparePendingPlan,
  recordPlanRun,
} from '../src/commands/confirmation.js'
import { stateFilePath } from '../src/runtime/state.js'

async function withEnv(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-plan-codes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { DSH_MAA_CLI_STATE_DIR: dir }
}

function agent(id, events = [{ type: 'turn/start', data: { turn: 1 } }]) {
  return { id, session: { snapshotEvents: () => events } }
}

test('a cancelled code is refused permanently by every confirmation path', async t => {
  const env = await withEnv(t)
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  const owner = agent('codes-a', events)
  await preparePendingPlan(owner, { document: {}, planSummary: 'plan' }, { env, code: 'MAA-C0DE01', now: 1_000 })
  const cancelled = await cancelPendingPlan(owner, 'MAA-C0DE01', { env, now: 2_000 })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.alreadyClosed, false)

  await assert.rejects(consumePlanFromHumanGesture(owner, 'MAA-C0DE01', { env, now: 3_000 }), error => error.code === 'MAA_PLAN_CANCELLED' && /已被取消，已永久失效/u.test(error.message))
  events.push({ type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '确认执行 MAA-C0DE01' }] } })
  await assert.rejects(consumeConfirmedPlan({ agent: owner }, 'MAA-C0DE01', { env, now: 3_000 }), /No pending MAA plan for MAA-C0DE01: the code was cancelled/u)
  await assert.rejects(assertPlanCodeOpen(owner, 'MAA-C0DE01', { env }), /已被取消/u)

  // Cancelling again is a harmless no-op; the plan is gone from disk.
  const again = await cancelPendingPlan(owner, 'MAA-C0DE01', { env, now: 4_000 })
  assert.equal(again.alreadyClosed, true)
  const stored = JSON.parse(await readFile(stateFilePath(env), 'utf8'))
  assert.deepEqual(stored.plans, {})
  assert.equal(stored.closed['MAA-C0DE01'].status, 'cancelled')

  // A new plan in the same session does not resurrect the old code.
  await preparePendingPlan(owner, { document: {}, planSummary: 'next' }, { env, code: 'MAA-C0DE02', now: 5_000 })
  await assert.rejects(consumePlanFromHumanGesture(owner, 'MAA-C0DE01', { env, now: 5_100 }), /已被取消/u)
  assert.equal((await peekPendingPlan(owner, { env })).confirmationCode, 'MAA-C0DE02')
})

test('a superseded or expired code explains itself and cannot run', async t => {
  const env = await withEnv(t)
  const owner = agent('codes-b')
  await preparePendingPlan(owner, { document: {}, planSummary: 'first' }, { env, code: 'MAA-0LD001', now: 1_000 })
  await preparePendingPlan(owner, { document: {}, planSummary: 'second' }, { env, code: 'MAA-NEW001', now: 2_000 })
  await assert.rejects(consumePlanFromHumanGesture(owner, 'MAA-0LD001', { env, now: 2_100 }), /已被新的计划替换/u)
  assert.equal((await cancelPendingPlan(owner, 'MAA-0LD001', { env, now: 2_200 })).status, 'superseded')

  await assert.rejects(consumePlanFromHumanGesture(owner, 'MAA-NEW001', { env, now: 2_000 + 30 * 60_000 + 1 }), /超过 30 分钟/u)
  await assert.rejects(consumePlanFromHumanGesture(owner, 'MAA-NEW001', { env, now: 2_000 + 30 * 60_000 + 2 }), /已超过 30 分钟有效期/u)
})

test('cancelling a code that already became a run points at the run instead', async t => {
  const env = await withEnv(t)
  const owner = agent('codes-c')
  await preparePendingPlan(owner, { document: {}, planSummary: 'run me' }, { env, code: 'MAA-RUN001', now: 1_000 })
  await consumePlanFromHumanGesture(owner, 'MAA-RUN001', { env, now: 1_100 })
  await recordPlanRun(owner, 'MAA-RUN001', 'RUN-0000ABCD', { env })
  await assert.rejects(
    cancelPendingPlan(owner, 'MAA-RUN001', { env, now: 1_200 }),
    error => error.code === 'MAA_PLAN_CONFIRMED' && error.closed.runId === 'RUN-0000ABCD',
  )
  await assert.rejects(consumePlanFromHumanGesture(owner, 'MAA-RUN001', { env, now: 1_300 }), /已被确认并开始执行/u)
})

test('tombstones are scoped to the session that owned the code', async t => {
  const env = await withEnv(t)
  const owner = agent('codes-d')
  const other = agent('codes-e')
  await preparePendingPlan(owner, { document: {}, planSummary: 'mine' }, { env, code: 'MAA-5C0PE1', now: 1_000 })
  await cancelPendingPlan(owner, 'MAA-5C0PE1', { env, now: 1_100 })
  assert.equal(await closedPlanStatus(other, 'MAA-5C0PE1', { env }), null)
  await assert.rejects(cancelPendingPlan(other, 'MAA-5C0PE1', { env, now: 1_200 }), error => error.code === 'MAA_PLAN_NOT_FOUND')
  assert.equal((await closedPlanStatus(owner, 'MAA-5C0PE1', { env })).status, 'cancelled')
})

test('confirm and cancel issued together never both succeed', async t => {
  const env = await withEnv(t)
  for (let round = 0; round < 20; round += 1) {
    const owner = agent(`codes-race-${round}`)
    const code = `MAA-${String(round).padStart(6, '0')}`
    await preparePendingPlan(owner, { document: {}, planSummary: 'race' }, { env, code })
    const outcomes = await Promise.allSettled(round % 2
      ? [cancelPendingPlan(owner, code, { env }), consumePlanFromHumanGesture(owner, code, { env })]
      : [consumePlanFromHumanGesture(owner, code, { env }), cancelPendingPlan(owner, code, { env })])
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
    const closed = await closedPlanStatus(owner, code, { env })
    assert.ok(['cancelled', 'confirmed'].includes(closed.status))
  }
})
