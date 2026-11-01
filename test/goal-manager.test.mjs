import assert from 'node:assert/strict'
import test from 'node:test'

import { planGoal } from '../src/agent/goal-manager.js'

const itemIndex = {
  byId: new Map([['30011', { id: '30011', name: '源岩' }]]),
  byName: new Map([['源岩', { id: '30011', name: '源岩' }]]),
}
const stages = [{ code: '1-7', apCost: 6, dropInfos: [{ itemId: '30011', dropType: 'NORMAL_DROP' }] }]

test('daily goal uses conservative resource defaults', async () => {
  const plan = await planGoal({ kind: 'daily' })
  assert.equal(plan.constraints.allowStone, false)
  assert.equal(plan.constraints.maxMedicine, 0)
  assert.deepEqual(plan.steps.map(step => step.maa.type), ['StartUp', 'Infrast', 'Mall', 'Award'])
  assert.equal(plan.steps.find(step => step.maa.type === 'Mall').maa.params.shopping, false)
})

test('operator training scans unknown state and does not schedule farming first', async () => {
  const plan = await planGoal({ kind: 'operator_training', operator: '结城理', requirements: [{ itemId: '30011', quantity: 10, stage: '1-7', runs: 2 }] }, {})
  assert.deepEqual(plan.steps.map(step => step.kind === 'maa' ? step.maa.type : step.kind), ['OperBox', 'Depot', 'decision'])
  assert.equal(plan.steps.some(step => step.maa?.type === 'Fight'), false)
})

test('operator training derives promotion costs and one verified farming iteration from updated data', async () => {
  const planningData = {
    version: 4, server: 'CN', updatedAt: '2026-10-30T00:00:00.000Z', stale: false, warning: '',
    operators: [{ id: 'char_4217_makoto', name: '结城理', rarity: 6, phases: [
      { maxLevel: 2, evolveCost: [] }, { maxLevel: 2, evolveCost: [{ id: '30012', count: 2 }] }, { maxLevel: 3, evolveCost: [] },
    ] }],
    leveling: { characterExpMap: [[100], [200], [300, 400]], characterUpgradeCostMap: [[10], [20], [30, 40]], evolveGoldCost: [[], [], [], [], [], [30000, 180000]] },
    matrix: [{ stageId: 'main_01-07', itemId: '30012', quantity: 250, times: 200, start: 1, end: null }],
    sources: { gamedata: { retrievedAt: '2026-10-30T00:00:00.000Z' }, penguin: { retrievedAt: '2026-10-30T00:00:00.000Z' } },
  }
  const index = {
    byId: new Map([['30012', { id: '30012', name: '固源岩' }], ['4001', { id: '4001', name: '龙门币' }], ['2004', { id: '2004', name: '高级作战记录' }]]),
    byName: new Map(),
  }
  const plan = await planGoal({ kind: 'operator_training', operator: '结城理', targetElite: 1, targetLevel: 1 }, {
    operatorBox: { operators: [{ id: 'char_4217_makoto', name: '结城理', elite: 0, level: 1, potential: 1 }] },
    depot: { items: { 30012: 0, 4001: 999999, 2004: 99 } }, itemIndex: index, planningData,
    stages: [{ stageId: 'main_01-07', code: '1-7', apCost: 6, dropInfos: [{ itemId: '30012', dropType: 'NORMAL_DROP' }] }],
  })
  assert.equal(plan.status, 'ready')
  assert.deepEqual(plan.steps.map(step => step.kind === 'maa' ? step.maa.type : step.kind), ['Fight', 'Depot', 'decision'])
  assert.equal(plan.steps[0].maa.params.stage, '1-7')
  assert.equal(plan.steps[0].maa.params.times, 2)
  assert.match(plan.facts.join('\n'), /统计 200 次/u)
})

test('material goal computes inventory gap and creates a budgeted fight', async () => {
  const plan = await planGoal({
    kind: 'materials', requirements: [{ name: '源岩', quantity: 10, stage: '1-7', runs: 2 }],
    budget: { maxSanity: 20 },
  }, { depot: { items: { 30011: 3 } }, itemIndex, stages })
  assert.equal(plan.gaps[0].gap, 7)
  assert.equal(plan.steps[0].maa.type, 'Fight')
  assert.equal(plan.steps[0].maa.params.stone, 0)
})

test('material plan blocks a fight that exceeds the sanity budget', async () => {
  const plan = await planGoal({
    kind: 'materials', requirements: [{ itemId: '30011', quantity: 10, stage: '1-7', runs: 2 }],
    budget: { maxSanity: 10 },
  }, { depot: { items: { 30011: 0 } }, itemIndex, stages })
  assert.equal(plan.status, 'needs_input')
  assert.match(plan.needsUser, /超过预算/u)
})

test('missing inventory or requirements never becomes an invented zero-gap result', async () => {
  const noDepot = await planGoal({ kind: 'materials', requirements: [{ itemId: '30011', quantity: 10 }] }, { itemIndex, stages })
  assert.deepEqual(noDepot.steps.map(step => step.kind === 'maa' ? step.maa.type : step.kind), ['Depot', 'decision'])
  const noRequirements = await planGoal({ kind: 'materials' }, { depot: { items: {} }, itemIndex, stages })
  assert.equal(noRequirements.status, 'needs_input')
  assert.equal(noRequirements.facts.includes('已提供的材料需求均由当前仓库满足。'), false)
})

test('unknown items are rejected instead of guessed', async () => {
  await assert.rejects(
    planGoal({ kind: 'materials', requirements: [{ name: '不存在材料', quantity: 1 }] }, { depot: { items: {} }, itemIndex, stages }),
    /找不到材料/u,
  )
})

test('ArkPlanner suggestions produce a plan instead of crashing the fact list', async () => {
  const planningData = {
    version: 4, server: 'CN', updatedAt: '2026-10-30T00:00:00.000Z', stale: false, warning: '',
    operators: [{ id: 'c1', name: '清流', rarity: 4, phases: [{ maxLevel: 2, evolveCost: [] }, { maxLevel: 2, evolveCost: [{ id: '30012', count: 5 }] }, { maxLevel: 2, evolveCost: [] }] }],
    leveling: { characterExpMap: [[0], [0], [0]], characterUpgradeCostMap: [[0], [0], [0]], evolveGoldCost: [[], [], [], [0, 0], [], []] },
    matrix: [], sources: { gamedata: {}, penguin: {} },
  }
  let asked = null
  const plan = await planGoal({ kind: 'operator_training', operator: '清流', targetElite: 1, targetLevel: 1 }, {
    operatorBox: { operators: [{ id: 'c1', name: '清流', elite: 0, level: 1, potential: 1 }] },
    depot: { items: { 30012: 0 } }, itemIndex: { byId: new Map([['30012', { id: '30012', name: '固源岩' }]]), byName: new Map() }, planningData,
    stages: [{ stageId: 'main_01-07', code: '1-7', apCost: 6, dropInfos: [{ itemId: '30012', dropType: 'NORMAL_DROP' }] }],
    jointPlanner: async requirements => { asked = requirements; return { source: 'arkplanner', cost: 60, stages: [{ stage: '1-7', count: 10, items: { 30012: 5.2 } }], syntheses: [] } },
  })
  assert.deepEqual(asked, [{ itemId: '30012', quantity: 5 }])
  assert.equal(plan.status, 'ready')
  assert.deepEqual(plan.steps.map(step => step.maa?.type ?? step.kind), ['Fight', 'Depot', 'decision'])
  assert.equal(plan.steps[0].maa.params.times, 10)
  assert.equal(plan.steps[0].maa.params.series, 0)
  assert.match(plan.facts.join('\n'), /ArkPlanner 建议 1-7 共 10 次，预计获得约 5\.2 个/u)
})
