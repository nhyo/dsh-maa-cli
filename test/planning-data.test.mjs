import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyDropRates, applyJointPlan, expandSynthesis, loadPlanningData, operatorUpgradeRequirements, planningDataFilePath, planWithArkPlanner, rankDropStages, serverWeekday, weeklyStageSchedule } from '../src/agent/planning-data.js'

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
  assert.equal(calls, 7)
  const cached = await loadPlanningData({ env, now: 1_700_000_100_000, fetchImpl, urls })
  assert.equal(cached.updatedAt, first.updatedAt)
  assert.equal(calls, 7)
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

function v2Fixtures() {
  const base = fixtures()
  base.characters.char_0.allSkillLvlup = Array.from({ length: 6 }, (_, index) => ({ lvlUpCost: [{ id: '3301', count: index + 1, type: 'MATERIAL' }] }))
  base.characters.char_0.skills = [
    { skillId: 's1', levelUpCostCond: [] },
    { skillId: 's2', levelUpCostCond: [
      { levelUpCost: [{ id: '3303', count: 4, type: 'MATERIAL' }, { id: '30073', count: 3, type: 'MATERIAL' }] },
      { levelUpCost: [{ id: '3303', count: 4, type: 'MATERIAL' }] },
      { levelUpCost: [{ id: '3303', count: 6, type: 'MATERIAL' }] },
    ] },
  ]
  const zones = {
    zones: {
      weekly_1: { zoneID: 'weekly_1', type: 'WEEKLY', zoneNameSecond: '固若金汤' },
      weekly_chips1: { zoneID: 'weekly_chips1', type: 'WEEKLY', zoneNameSecond: '医疗芯片' },
      main_0: { zoneID: 'main_0', type: 'MAINLINE' },
    },
    // Same key and shape as the real cn zone_table.json.
    weeklyAdditionInfo: {
      weekly_1: { daysOfWeek: [1, 4, 5, 7], type: 'MATERIAL' },
      weekly_chips1: { daysOfWeek: [1, 4], type: 'EVOLVE' },
    },
  }
  const modules = { equipDict: {
    uniequip_001: { charId: 'char_0', uniEquipName: '证章', typeName2: null, itemCost: null },
    uniequip_002: { charId: 'char_0', uniEquipName: 'X 模组', typeName1: 'SPC', typeName2: 'X', itemCost: {
      1: [{ id: 'mod_unlock_token', count: 1, type: 'MATERIAL' }, { id: '4001', count: 20000, type: 'GOLD' }],
      2: [{ id: 'mod_update_token_1', count: 20, type: 'MATERIAL' }],
      3: [{ id: 'mod_update_token_2', count: 8, type: 'MATERIAL' }],
    } },
  } }
  const building = { workshopFormulas: {
    1: { itemId: '30013', count: 1, goldCost: 300, formulaType: 'F_EVOLVE', costs: [{ id: '30012', count: 4, type: 'MATERIAL' }] },
    2: { itemId: '30014', count: 1, goldCost: 400, formulaType: 'F_EVOLVE', costs: [{ id: '30013', count: 2, type: 'MATERIAL' }] },
    3: { itemId: '3213', count: 1, goldCost: 0, formulaType: 'F_ASC', costs: [{ id: '3212', count: 2, type: 'MATERIAL' }] },
  } }
  // Same shape as the real stage_table.json.
  const stageZones = { stages: { wk_melee_6: { zoneId: 'weekly_1', code: 'CE-6' }, pro_a_1: { zoneId: 'weekly_chips1', code: 'PR-A-1' }, 'main_01-07': { zoneId: 'main_1', code: '1-7' } } }
  return { ...base, zones, modules, building, stageZones }
}

function v2Fetcher(values) {
  return async url => {
    const data = url.includes('character') ? values.characters : url.includes('const') ? values.constants
      : url.includes('zone') ? values.zones : url.includes('uniequip') ? values.modules : url.includes('building') ? values.building
        : url.includes('stage_table') ? values.stageZones : values.matrix
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(data) }
  }
}
const V2_URLS = { characters: 'https://test/character', constants: 'https://test/const', matrix: 'https://test/matrix', zones: 'https://test/zone', modules: 'https://test/uniequip', building: 'https://test/building', stageZones: 'https://test/stage_table' }

test('v2 data computes skill, mastery and module costs and never assumes unknown current levels', async t => {
  const env = await temporaryEnv(t)
  const data = await loadPlanningData({ env, now: 1_700_000_000_000, fetchImpl: v2Fetcher(v2Fixtures()), urls: V2_URLS })
  assert.equal(data.version, 3)
  assert.equal(data.warning, '')
  const current = { id: 'char_0', elite: 2, level: 1 }
  const result = operatorUpgradeRequirements(data, {
    operator: '结城理', current, skillLevel: { current: 5, target: 7 },
    masteries: [{ skill: 2, current: 0, target: 3 }], modules: [{ type: 'X', current: 0, target: 2 }],
  })
  const quantity = id => result.requirements.find(item => item.itemId === id)?.quantity
  assert.equal(quantity('3301'), 5 + 6)
  assert.equal(quantity('3303'), 14)
  assert.equal(quantity('30073'), 3)
  assert.equal(quantity('mod_unlock_token'), 1)
  assert.equal(quantity('mod_update_token_1'), 20)
  assert.equal(quantity('4001'), 20000)
  assert.deepEqual(result.target, { elite: 2, level: 1 })
  assert.throws(() => operatorUpgradeRequirements(data, { operator: '结城理', current, masteries: [{ skill: 2, target: 3 }] }), error => error.code === 'MAA_NEEDS_INPUT')
  assert.throws(() => operatorUpgradeRequirements(data, { operator: '结城理', current: { id: 'char_0', elite: 1, level: 1 }, masteries: [{ skill: 2, current: 0, target: 1 }] }), /精英二/u)
})

test('workshop expansion deducts stock first and only expands material formulas', async t => {
  const env = await temporaryEnv(t)
  const data = await loadPlanningData({ env, now: 1_700_000_000_000, fetchImpl: v2Fetcher(v2Fixtures()), urls: V2_URLS })
  const expanded = expandSynthesis([{ itemId: '30014', quantity: 2 }, { itemId: '3213', quantity: 1 }], data, { items: { 30014: 1, 30013: 1 } })
  const quantity = id => expanded.requirements.find(item => item.itemId === id)?.quantity
  // 1 more 30014 → 2 × 30013, 1 in stock → 1 crafted → 4 × 30012
  assert.equal(quantity('30014'), 1)
  assert.equal(quantity('30013'), 1)
  assert.equal(quantity('30012'), 4)
  assert.equal(quantity('3213'), 1)
  assert.equal(expanded.workshopLmd, 700)
})

test('weekly schedule uses the 04:00 server-day boundary and MAA stage zones', async t => {
  const env = await temporaryEnv(t)
  const data = await loadPlanningData({ env, now: 1_700_000_000_000, fetchImpl: v2Fetcher(v2Fixtures()), urls: V2_URLS })
  // Same shape as MAA's stages.json: stageId and code, no zoneId.
  const stages = [{ code: 'CE-6', stageId: 'wk_melee_6' }, { code: 'PR-A-1', stageId: 'pro_a_1' }, { code: '1-7', stageId: 'main_01-07' }]
  // 2026-11-02 is a Monday. 03:00 CN time is still Sunday's game day.
  const mondayNoon = Date.parse('2026-11-02T04:00:00Z')
  const mondayEarly = Date.parse('2026-11-01T19:00:00Z')
  assert.equal(serverWeekday(mondayNoon, 'CN'), 1)
  assert.equal(serverWeekday(mondayEarly, 'CN'), 7)
  const schedule = weeklyStageSchedule(data, stages, { now: mondayNoon })
  assert.deepEqual(schedule.zones.map(zone => [zone.stages[0], zone.openToday, zone.kind]), [['CE-6', true, 'resource'], ['PR-A-1', true, 'chip']])
  const tuesday = weeklyStageSchedule(data, stages, { now: mondayNoon + 24 * 3600_000 })
  assert.deepEqual(tuesday.zones.map(zone => zone.openToday), [false, false])
})

test('ArkPlanner joint plan assigns stages and falls back when unavailable', async () => {
  const itemIndex = { byId: new Map([['30012', { id: '30012', name: '固源岩' }], ['30062', { id: '30062', name: '装置' }]]) }
  let body
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ cost: 120, stages: [{ stage: '1-7', count: '20', items: { 30012: '25.0' } }, { stage: '4-10', count: '5', items: { 30062: '2.1', 30012: '1' } }] }) }
  }
  const plan = await planWithArkPlanner({ requirements: [{ itemId: '30012', quantity: 30 }, { itemId: '30062', quantity: 2 }, { itemId: '4001', quantity: 1 }], depot: { items: { 30012: 5 } }, itemIndex }, { fetchImpl })
  assert.deepEqual(body.required, { 固源岩: 30, 装置: 2 })
  assert.deepEqual(body.owned, { 固源岩: 5 })
  assert.equal(body.output_lang, 'id')
  const assigned = applyJointPlan([{ itemId: '30012', quantity: 30 }, { itemId: '30062', quantity: 2 }], plan, { items: { 30012: 5 } })
  assert.deepEqual(assigned.map(item => [item.stage, item.runs]), [['1-7', 20], ['4-10', 5]])
  const offline = await planWithArkPlanner({ requirements: [{ itemId: '30012', quantity: 30 }], itemIndex }, { fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(offline.source, 'unavailable')
  assert.equal(offline.stages.length, 0)
})

test('real game tables: chip stages keep their own zones and open days', async t => {
  const env = await temporaryEnv(t)
  const real = JSON.parse(await readFile(new URL('./fixtures/weekly-stages.json', import.meta.url), 'utf8'))
  const values = { ...v2Fixtures(), zones: real.zoneTable, stageZones: real.stageTable }
  const data = await loadPlanningData({ env, now: 1_700_000_000_000, fetchImpl: v2Fetcher(values), urls: V2_URLS })
  const monday = Date.parse('2026-11-02T04:00:00Z')
  const schedule = weeklyStageSchedule(data, real.maaStages, { now: monday })
  const open = Object.fromEntries(schedule.zones.map(zone => [zone.name, zone.openToday]))
  // Monday: PR-A [1,4,5,7] and PR-B [1,2,5,6] open, PR-C [3,4,6,7] and PR-D [2,3,6,7] closed.
  assert.deepEqual([open['固若金汤'], open['摧枯拉朽'], open['势不可挡'], open['身先士卒']], [true, true, false, false])
  // Resource stages: AP [1,4,6,7] open, CA [2,3,5,7] closed, SK [1,3,5,6] open, CE [2,4,6,7] closed, LS every day.
  assert.deepEqual([open['粉碎防御'], open['空中威胁'], open['资源保障'], open['货物运送'], open['战术演习']], [true, false, true, false, true])
  const prB = schedule.zones.find(zone => zone.name === '摧枯拉朽')
  assert.equal(prB.kind, 'chip')
  assert.ok(prB.stages.includes('PR-B-2'))
  assert.ok(schedule.zones.find(zone => zone.name === '货物运送').stages.includes('CE-6'))
})
