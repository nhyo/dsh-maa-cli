import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { depotFilePath, loadItemIndex, parseCompletedDepot, queryDepot, readDepot, saveDepot } from '../src/operators/depot.js'

function callback(details) {
  return `Depot: ${JSON.stringify({ taskchain: 'Depot', what: 'DepotInfo', details })}\n`
}

test('parses, persists, and queries a completed DepotInfo callback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-depot-'))
  const resource = path.join(root, 'resource')
  const env = { DSH_MAA_CLI_STATE_DIR: path.join(root, 'state') }
  await mkdir(resource, { recursive: true })
  await writeFile(path.join(resource, 'item_index.json'), JSON.stringify({ 30011: { name: '源岩', classifyType: 'MATERIAL' }, 4001: { name: '龙门币', classifyType: 'MATERIAL' } }))
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshot = parseCompletedDepot(callback({ done: false, data: '{}' }) + callback({ done: true, data: '{"30011":12,"4001":50000}' }), Date.parse('2026-10-30T12:00:00Z'))
  await saveDepot(snapshot, { env })
  assert.equal(depotFilePath(env), path.join(env.DSH_MAA_CLI_STATE_DIR, 'depot.json'))
  const loaded = await readDepot({ env })
  assert.equal(loaded.items['30011'], 12)
  const result = queryDepot(loaded, await loadItemIndex(resource), { name: '源岩' }, Date.parse('2026-10-30T12:01:00Z'))
  assert.equal(result.available, true)
  assert.deepEqual(result.items, [{ id: '30011', name: '源岩', quantity: 12 }])
  assert.equal(result.ageSeconds, 60)
})

test('rejects incomplete and malformed depot results', () => {
  assert.throws(() => parseCompletedDepot(callback({ done: false, data: '{}' })), /done=true/u)
  assert.throws(() => parseCompletedDepot(callback({ done: true, data: '[]' })), /格式无效/u)
  assert.throws(() => parseCompletedDepot(callback({ done: true, data: '{"30011":-1}' })), /数量无效/u)
})
