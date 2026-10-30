import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  extractOperBoxCallbacks,
  formatOperatorBoxScanResult,
  operatorBoxFilePath,
  parseCompletedOperatorBox,
  queryOperatorBox,
  readOperatorBox,
  saveOperatorBox,
  stripOperBoxCallbacks,
} from '../src/operators/operator-box.js'

const progress = {
  taskchain: 'OperBox', what: 'OperBoxInfo',
  details: { done: false, own_opers: [] },
}
const complete = {
  taskchain: 'OperBox', what: 'OperBoxInfo',
  details: {
    done: true,
    own_opers: [
      { id: 'char_017_huang', name: '夜莺', own: true, rarity: 6, elite: 2, level: 60, potential: 2 },
      { id: 'char_002_amiya', name: '阿米娅', own: true, rarity: 5, elite: 2, level: 80, potential: 6 },
      { id: 'char_1038_whitw2', name: '维什戴尔', own: true, rarity: 6, elite: 1, level: 80, potential: 1 },
    ],
  },
}

function callbackLog(message) {
  return `INFO before\nOperBox: ${JSON.stringify(message, null, 2)}\nINFO after\n`
}

test('extracts the final completed OperBox callback and strips the raw roster log', () => {
  const log = `${callbackLog(progress)}${callbackLog(complete)}`
  assert.equal(extractOperBoxCallbacks(log).length, 2)
  const snapshot = parseCompletedOperatorBox(log, Date.parse('2026-10-29T12:00:00Z'))
  assert.equal(snapshot.scannedAt, '2026-10-29T12:00:00.000Z')
  assert.deepEqual(snapshot.operators.map(operator => operator.name), ['维什戴尔', '夜莺', '阿米娅'])
  assert.doesNotMatch(stripOperBoxCallbacks(log), /own_opers|维什戴尔/)
  assert.match(stripOperBoxCallbacks(log), /INFO before/)
})

test('rejects incomplete or malformed operator results', () => {
  assert.throws(() => parseCompletedOperatorBox(callbackLog(progress)), /done=true/)
  const malformed = structuredClone(complete)
  malformed.details.own_opers[0].rarity = 7
  assert.throws(() => parseCompletedOperatorBox(callbackLog(malformed)), /rarity/)
})

test('persists the private cache and answers filtered roster queries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-operator-box-'))
  const env = { DSH_MAA_CLI_STATE_DIR: root }
  try {
    assert.equal(await readOperatorBox({ env }), null)
    const snapshot = parseCompletedOperatorBox(callbackLog(complete), Date.parse('2026-10-29T12:00:00Z'))
    assert.equal(await saveOperatorBox(snapshot, { env }), operatorBoxFilePath(env))
    assert.deepEqual(JSON.parse(await readFile(operatorBoxFilePath(env), 'utf8')), snapshot)

    const sixStars = queryOperatorBox(await readOperatorBox({ env }), { rarity: 6 }, Date.parse('2026-10-29T13:00:00Z'))
    assert.equal(sixStars.available, true)
    assert.equal(sixStars.totalOwned, 3)
    assert.equal(sixStars.matched, 2)
    assert.equal(sixStars.ageSeconds, 3600)
    assert.deepEqual(sixStars.operators.map(operator => operator.name), ['维什戴尔', '夜莺'])

    const notEliteTwo = queryOperatorBox(snapshot, { rarity: 6, eliteBelow: 2 })
    assert.deepEqual(notEliteTwo.operators.map(operator => operator.name), ['维什戴尔'])
    assert.match(formatOperatorBoxScanResult(snapshot), /六星 2 名/)

    await writeFile(operatorBoxFilePath(env), 'not json', 'utf8')
    assert.equal(await readOperatorBox({ env }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports an unavailable cache without touching the game', () => {
  const result = queryOperatorBox(null, { rarity: 6 })
  assert.equal(result.available, false)
  assert.deepEqual(result.operators, [])
  assert.match(result.summary, /OperBox/)
})
