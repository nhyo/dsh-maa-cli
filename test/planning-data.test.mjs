import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyDropRates, loadPlanningData, operatorUpgradeRequirements, planningDataFilePath, rankDropStages } from '../src/agent/planning-data.js'

async function temporaryEnv(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-planning-data-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { DSH_MAA_CLI_STATE_DIR: dir }
}

function fixtures() {
  const characters = {}
  for (let index = 0; index < 100; index += 1) {
    characters[`char_${index}`] = {
      name: index === 0 ? '结城理' : `测试干员${index}`, rarity: 'TIER_6',
      phases: [
        { maxLevel: 2, evolveCost: null },
        { maxLevel: 2, evolveCost: [{ id: '30012', count: 2, type: 'MATERIAL' }] },
        { maxLevel: 3, evolveCost: [{ id: '30165', count: 1, type: 'MATERIAL' }] },
      ],
    }
  }
  const constants = {
    characterExpMap: [[100], [200], [300, 400]],
    characterUpgradeCostMap: [[10], [20], [30, 40]],
    evolveGoldCost: [[], [], [], [], [], [30_000, 180_000]],
  }
  const matrix = { matrix: [
    { stageId: 'main_01-07', itemId: '30012', quantity: 250, times: 200, start: 1, end: null },
    { stageId: 'main_02-01', itemId: '30012', quantity: 160, times: 200, start: 1, end: null },
    { stageId: 'main_low', itemId: '30012', quantity: 99, times: 99, start: 1, end: null },
  ] }
  return { characters, constants, matrix }
}

function fetcher(values, fail = false) {
  return async url => {
    if (fail) throw new Error('offline')
    const data = url.includes('character') ? values.characters : url.includes('const') ? values.constants : values.matrix
    return { ok: true, status: 200, headers: { get: key => key === 'etag' ? 'etag-1' : null }, text: async () => JSON.stringify(data) }
  }
}

test('downloads, compacts, persists, and reuses planning data for 24 hours', async t => {
  const env = await temporaryEnv(t)
  const values = fixtures()
  let calls = 0
  const fetchImpl = async url => { calls += 1; return await fetcher(values)(url) }
  const urls = { characters: 'https://test/character', constants: 'https://test/const', matrix: 'https://test/matrix' }
  const first = await loadPlanningData({ env, now: 1_700_000_000_000, fetchImpl, urls })
  assert.equal(first.operators.find(item => item.name === '结城理').id, 'char_0')
  assert.equal(first.sources.gamedata.etags[0], 'etag-1')
  assert.equal(calls, 3)
  const cached = await loadPlanningData({ env, now: 1_700_000_100_000, fetchImpl, urls })
  assert.equal(cached.updatedAt, first.updatedAt)
  assert.equal(calls, 3)
  assert.equal(planningDataFilePath(env), path.join(env.DSH_MAA_CLI_STATE_DIR, 'planning-data.json'))
})

test('keeps the last verified cache when an automatic refresh fails', async t => {
  const env = await temporaryEnv(t)
  const urls = { characters: 'https://test/character', constants: 'https://test/const', matrix: 'https://test/matrix' }
  await loadPlanningData({ env, now: 1_700_000_000_000, fetchImpl: fetcher(fixtures()), urls })
  const stale = await loadPlanningData({ env, now: 1_700_100_000_000, force: true, fetchImpl: fetcher(fixtures(), true), urls })
  assert.equal(stale.stale, true)
  assert.match(stale.warning, /沿用上次已验证缓存/u)
})

test('computes promotion, leveling, LMD, and battle-record requirements from game data', async t => {
  const env = await temporaryEnv(t)
  const urls = { characters: 'https://test/character', constants: 'https://test/const', matrix: 'https://test/matrix' }
  const data = await loadPlanningData({ env, now: 1_700_000_000_000, fetchImpl: fetcher(fixtures()), urls })
  const result = operatorUpgradeRequirements(data, {
    operator: '结城理', current: { id: 'char_0', elite: 0, level: 1 }, targetElite: 2, targetLevel: 1,
    depot: { items: { 2001: 1, 2004: 0 } },
  })
  assert.equal(result.totalExp, 300)
  assert.equal(result.totalLmd, 210_030)
  assert.deepEqual(result.requirements.find(item => item.itemId === '30012'), { itemId: '30012', quantity: 2 })
  assert.deepEqual(result.requirements.find(item => item.itemId === '30165'), { itemId: '30165', quantity: 1 })
  assert.deepEqual(result.requirements.find(item => item.itemId === '2004'), { itemId: '2004', quantity: 1 })
})

test('ranks only current sufficiently sampled MAA stages and converts rates into run counts', async t => {
  const env = await temporaryEnv(t)
  const urls = { characters: 'https://test/character', constants: 'https://test/const', matrix: 'https://test/matrix' }
  const data = await loadPlanningData({ env, now: 1_700_000_000_000, fetchImpl: fetcher(fixtures()), urls })
  const stages = [
    { stageId: 'main_01-07', code: '1-7', apCost: 6 },
    { stageId: 'main_02-01', code: '2-1', apCost: 9 },
    { stageId: 'main_low', code: 'S-1', apCost: 1 },
  ]
  const ranked = rankDropStages(data, '30012', stages)
  assert.deepEqual(ranked.map(item => item.stage), ['1-7', '2-1'])
  const applied = applyDropRates([{ itemId: '30012', quantity: 10 }], data, { items: { 30012: 2 } }, stages)
  assert.equal(applied[0].stage, '1-7')
  assert.equal(applied[0].runs, 7)
  assert.equal(applied[0].drop.samples, 200)
})
