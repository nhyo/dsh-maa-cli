import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  clearStateForTest,
  dropPendingPlan,
  loadPendingPlan,
  prunedPlans,
  prunePendingPlans,
  readState,
  savePendingPlan,
  stateDirectory,
  stateFilePath,
  writeState,
} from '../src/runtime/state.js'

async function makeEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-state-'))
  return { root, env: { DSH_MAA_CLI_STATE_DIR: root } }
}

test('defaults to the DSH home and honours the override', () => {
  assert.match(stateDirectory({}), /\.dsh[\\/]maa-cli$/)
  assert.equal(stateDirectory({ DSH_MAA_CLI_STATE_DIR: 'C:\\state' }), path.resolve('C:\\state'))
  assert.equal(stateFilePath({ DSH_MAA_CLI_STATE_DIR: 'C:\\state' }), path.join(path.resolve('C:\\state'), 'pending-plans.json'))
})

test('persists, reads back, and drops a single plan', async () => {
  const { root, env } = await makeEnv()
  try {
    assert.deepEqual(await readState(env), { version: 1, plans: {} })

    await savePendingPlan('session-a', { confirmationCode: 'MAA-1', preparedAt: 1_000 }, { env })
    await savePendingPlan('session-b', { confirmationCode: 'MAA-2', preparedAt: 1_000 }, { env })

    assert.deepEqual(await loadPendingPlan('session-a', { env }), { confirmationCode: 'MAA-1', preparedAt: 1_000 })
    const stored = JSON.parse(await readFile(stateFilePath(env), 'utf8'))
    assert.equal(stored.version, 1)
    assert.deepEqual(Object.keys(stored.plans).sort(), ['session-a', 'session-b'])

    await dropPendingPlan('session-a', { env })
    assert.equal(await loadPendingPlan('session-a', { env }), null)
    assert.notEqual(await loadPendingPlan('session-b', { env }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tolerates a missing, corrupt, or foreign store', async () => {
  const { root, env } = await makeEnv()
  try {
    await writeFile(stateFilePath(env), 'not json', 'utf8')
    assert.deepEqual(await readState(env), { version: 1, plans: {} })

    await writeFile(stateFilePath(env), JSON.stringify({ version: 99, plans: { a: 1 } }), 'utf8')
    assert.deepEqual(await readState(env), { version: 1, plans: {} })

    await writeState({ version: 1, plans: { 'session-c': { preparedAt: 5 } } }, env)
    assert.deepEqual(await loadPendingPlan('session-c', { env }), { preparedAt: 5 })

    await clearStateForTest(env)
    assert.deepEqual(await readState(env), { version: 1, plans: {} })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prunes expired plans and keeps valid ones', async () => {
  const plans = { fresh: { preparedAt: 10_000 }, stale: { preparedAt: 1_000 }, broken: { preparedAt: 'x' } }
  assert.deepEqual(Object.keys(prunedPlans(plans, 5_000, 12_000)).sort(), ['fresh'])

  const { root, env } = await makeEnv()
  try {
    await writeState({ version: 1, plans }, env)
    const kept = await prunePendingPlans(5_000, 12_000, { env })
    assert.deepEqual(Object.keys(kept), ['fresh'])
    assert.deepEqual(Object.keys((await readState(env)).plans), ['fresh'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
