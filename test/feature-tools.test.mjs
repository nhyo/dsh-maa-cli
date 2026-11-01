import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// End-to-end checks of the model tools added for drop targets, weekly stages,
// custom base schedules, copilot-site jobs and training estimates. They run the
// real plugin entry against test/fixtures/fake-maa.mjs and never start MAA.
const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_MAA = path.join(here, 'fixtures', 'fake-maa.mjs')
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-features-'))
const fakeRoot = path.join(root, 'maa')
const resourceDir = path.join(fakeRoot, 'resource')
const stateDir = path.join(root, 'state')
await mkdir(resourceDir, { recursive: true })
await mkdir(stateDir, { recursive: true })
let wrapper
if (process.platform === 'win32') {
  wrapper = path.join(root, 'fake-maa.cmd')
  await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${FAKE_MAA}" %*\r\n`)
} else {
  wrapper = path.join(root, 'fake-maa')
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_MAA}" "$@"\n`)
  await chmod(wrapper, 0o755)
}
Object.assign(process.env, { DSH_MAA_CLI_PATH: wrapper, FAKE_MAA_ROOT: fakeRoot, DSH_MAA_CLI_STATE_DIR: stateDir })
test.after(() => rm(root, { recursive: true, force: true }))

const { apply } = await import('../src/index.js')
const { serverWeekday } = await import('../src/agent/planning-data.js')
const { peekPendingPlan, clearPendingPlansForTest } = await import('../src/commands/confirmation.js')

const items = {
  30012: { name: '固源岩', classifyType: 'MATERIAL' }, 30013: { name: '固源岩组', classifyType: 'MATERIAL' },
  30062: { name: '装置', classifyType: 'MATERIAL' }, 4001: { name: '龙门币', classifyType: 'NORMAL' },
  2004: { name: '高级作战记录', classifyType: 'NORMAL' }, 3303: { name: '技巧概要·卷3', classifyType: 'MATERIAL' },
}
await writeFile(path.join(resourceDir, 'item_index.json'), JSON.stringify(items))
await writeFile(path.join(resourceDir, 'battle_data.json'), JSON.stringify({ chars: {
  char_1: { name: '红云', position: 'RANGED', profession: 'SNIPER' },
  char_2: { name: '清流', position: 'RANGED', profession: 'MEDIC' },
  char_3: { name: '砾', position: 'MELEE', profession: 'SPECIAL' },
} }))
await writeFile(path.join(resourceDir, 'stages.json'), JSON.stringify([
  // Same shape as the real MAA stages.json (no zoneId).
  { stageId: 'main_01-07', code: '1-7', apCost: 6, dropInfos: [{ itemId: '30012', dropType: 'NORMAL_DROP' }] },
  { stageId: 'wk_toxic_5', code: 'AP-5', apCost: 30, dropInfos: [] },
  { stageId: 'wk_melee_6', code: 'CE-6', apCost: 36, dropInfos: [] },
]))

const today = serverWeekday(Date.now(), 'CN')
const otherDays = [1, 2, 3, 4, 5, 6, 7].filter(day => day !== today)
const planningData = {
  version: 4, server: 'CN', updatedAt: new Date().toISOString(), stale: false, warning: '',
  operators: [{
    id: 'char_2', name: '清流', rarity: 4,
    phases: [{ maxLevel: 50, evolveCost: [] }, { maxLevel: 70, evolveCost: [{ id: '30012', count: 5 }] }, { maxLevel: 80, evolveCost: [{ id: '30062', count: 3 }] }],
    skillLevels: Array.from({ length: 6 }, () => []),
    masteries: [[[{ id: '3303', count: 2 }], [{ id: '3303', count: 4 }], [{ id: '3303', count: 6 }]]],
  }],
  leveling: { characterExpMap: [Array(80).fill(0), Array(80).fill(0), Array(80).fill(0)], characterUpgradeCostMap: [Array(80).fill(0), Array(80).fill(0), Array(80).fill(0)], evolveGoldCost: [[], [], [], [10000, 20000], [], []] },
  matrix: [{ stageId: 'main_01-07', itemId: '30012', quantity: 100, times: 200, start: 1, end: null }],
  weekly: {
    zones: { weekly_1: { name: '货物运送', kind: 'resource', daysOfWeek: [today] }, weekly_3: { name: '空中威胁', kind: 'resource', daysOfWeek: otherDays } },
    stageZones: { wk_melee_6: 'weekly_1', wk_toxic_5: 'weekly_3' },
  },
  modules: [], formulas: [],
  sources: { gamedata: { retrievedAt: new Date().toISOString() }, penguin: { retrievedAt: new Date().toISOString() } },
}
await writeFile(path.join(stateDir, 'planning-data.json'), JSON.stringify(planningData))
await writeFile(path.join(stateDir, 'operator-box.json'), JSON.stringify({ version: 1, scannedAt: new Date().toISOString(), operators: [
  { id: 'char_1', name: '红云', rarity: 4, elite: 2, level: 40, potential: 1 },
  { id: 'char_2', name: '清流', rarity: 4, elite: 1, level: 70, potential: 1 },
] }))
await writeFile(path.join(stateDir, 'depot.json'), JSON.stringify({ version: 1, scannedAt: new Date().toISOString(), items: { 30012: 2, 30062: 1, 3303: 3, 4001: 100000 } }))

const tools = []
const commands = []
apply({ tools: { register: tool => tools.push(tool) }, commands: { register: command => commands.push(command) } })
const tool = name => tools.find(item => item.name === name)
let turn = 0
function exec(id) {
  turn += 1
  const agent = { id, session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn } }] } }
  return { agent, signal: AbortSignal.timeout(10_000), concludeTurn() {} }
}
function jsonResponse(value) { return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) } }

test('Fight drop targets resolve item names and closed weekly stages are flagged', async () => {
  await clearPendingPlansForTest()
  const context = exec('drops')
  const result = await tool('maa_prepare_plan').execute({ purpose: '刷固源岩组', steps: [{ type: 'Fight', stage: '1-7', drops: { 固源岩组: 3 } }] }, context)
  const plan = JSON.parse(result.planJson)
  assert.deepEqual(plan.tasks[0].params.drops, { 30013: 3 })
  assert.equal(plan.tasks[0].params.times, 100)
  assert.match(result.planSummary, /固源岩组×3/u)
  await assert.rejects(tool('maa_prepare_plan').execute({ purpose: 'x', steps: [{ type: 'Fight', stage: '1-7', drops: { 不存在的东西: 1 } }] }, exec('drops-bad')), /找不到“不存在的东西”/u)
  const closed = await tool('maa_prepare_plan').execute({ purpose: '刷 AP-5', steps: [{ type: 'Fight', stage: 'AP-5', times: 1 }] }, exec('weekly'))
  assert.match(closed.planSummary, /AP-5（空中威胁）今天.*未开放/u)
  const open = await tool('maa_prepare_plan').execute({ purpose: '刷 CE-6', steps: [{ type: 'Fight', stage: 'CE-6', times: 1 }] }, exec('weekly-open'))
  assert.doesNotMatch(open.planSummary, /未开放/u)
  const annihilation = await tool('maa_prepare_plan').execute({ purpose: '打剿灭', steps: [{ type: 'Fight', stage: '剿灭', times: 1 }] }, exec('annihilation'))
  assert.equal(JSON.parse(annihilation.planJson).tasks[0].params.stage, 'Annihilation')
})

test('maa_stage_schedule lists only weekly stages the installed MAA knows', async () => {
  const result = await tool('maa_stage_schedule').execute({}, exec('schedule'))
  assert.equal(result.status, 'ready')
  assert.match(result.summary, /今天开放：\n货物运送（资源）：CE-6/u)
  assert.match(result.summary, /今天未开放：空中威胁/u)
})

test('maa_prepare_infrast compiles a validated custom schedule into a generated file', async () => {
  await clearPendingPlansForTest()
  const context = exec('infrast')
  const result = await tool('maa_prepare_infrast').execute({
    action: 'prepare', purpose: '赤金排班', saveAs: '赤金班',
    plans: [{ name: '白班', rooms: { manufacture: [{ count: 2, product: '赤金', autofill: true }], trading: [{ operators: ['红云', '不存在干员'] }], power: [{ operators: ['砾'] }] } }],
  }, context)
  assert.equal(result.status, 'pending_confirmation')
  assert.match(result.summary, /你还没有：砾/u)
  assert.match(result.summary, /不存在干员（MAA 干员数据中没有该干员）/u)
  assert.match(result.summary, /不会切换制造站/u)
  const pending = await peekPendingPlan(context.agent)
  assert.equal(pending.document.tasks[0].params.mode, 10000)
  assert.equal(pending.document.tasks[0].params.filename, pending.generatedFiles[0].marker)
  const schedule = pending.generatedFiles[0].content
  assert.deepEqual(schedule.plans[0].rooms.manufacture, [{ autofill: true, product: 'Pure Gold' }, { autofill: true, product: 'Pure Gold' }])
  assert.deepEqual(schedule.plans[0].rooms.trading, [{ operators: ['红云'] }])
  assert.deepEqual(schedule.plans[0].rooms.power, [{ operators: ['砾'] }])
  const listed = await tool('maa_prepare_infrast').execute({ action: 'list' }, exec('infrast-list'))
  assert.match(listed.summary, /赤金班/u)
  const reused = await tool('maa_prepare_infrast').execute({ action: 'prepare', useSaved: '赤金班' }, exec('infrast-reuse'))
  assert.equal(reused.status, 'pending_confirmation')
})

test('maa_copilot search ranks jobs by Box ownership and prepare stores the job as a generated file', async () => {
  const job = (id, opers) => ({ id, uploader: 'tester', views: 10, hot_score: id, content: JSON.stringify({ stage_name: 'H8-4', doc: { title: `作业${id}` }, opers: opers.map(name => ({ name, skill: 1 })), groups: [], actions: [] }) })
  const original = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('/copilot/query')) {
      assert.match(String(url), /level_keyword=H8-4/u)
      return jsonResponse({ status_code: 200, data: { has_next: false, data: [job(2, ['红云', '能天使']), job(1, ['红云', '清流']), { ...job(3, []), content: JSON.stringify({ stage_name: 'H8-4', opers: [{ name: '清流', skill: 3 }], groups: [] }) }] } })
    }
    if (String(url).endsWith('/copilot/get/2')) return jsonResponse({ status_code: 200, data: job(2, ['红云', '能天使']) })
    throw new Error(`unexpected ${url}`)
  }
  try {
    const search = await tool('maa_copilot').execute({ action: 'search', stage: 'H8-4' }, exec('copilot-search'))
    const ranked = JSON.parse(search.data)
    assert.deepEqual(ranked.map(item => [item.id, item.ownership.status]), [['1', 'ok'], ['3', 'missing'], ['2', 'missing']])
    // 清流 is only elite 1, so a skill-3 requirement counts as under-levelled.
    assert.match(ranked.find(item => item.id === '3').ownership.weak[0], /需要精2（3 技能），当前精1/u)
    assert.match(search.summary, /缺 能天使/u)
    await clearPendingPlansForTest()
    const context = exec('copilot-prepare')
    const prepared = await tool('maa_copilot').execute({ action: 'prepare', copilotId: 'maa://2', stage: 'H8-4' }, context)
    assert.match(prepared.summary, /缺少：能天使/u)
    const pending = await peekPendingPlan(context.agent)
    const task = pending.document.tasks[0]
    assert.equal(task.type, 'Copilot')
    assert.equal(task.params.copilot_list[0].stage_name, 'H8-4')
    assert.equal(task.params.copilot_list[0].filename, pending.generatedFiles[0].marker)
    assert.equal(task.params.use_sanity_potion, false)
    assert.equal(pending.generatedFiles[0].content.stage_name, 'H8-4')
  } finally {
    globalThis.fetch = original
  }
})

test('goal estimate answers “is my depot enough” read-only and asks for unknown mastery levels', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  try {
    const estimate = await tool('maa_goal_manager').execute({ action: 'estimate', operator: '清流', targetElite: 2, targetLevel: 1 }, exec('estimate'))
    assert.equal(estimate.status, 'ready')
    assert.match(estimate.summary, /装置：需要 3，库存 1，缺 2/u)
    assert.doesNotMatch(estimate.summary, /固源岩/u)
    assert.match(estimate.summary, /精1 70级 → 精2 1级/u)
    assert.match(estimate.summary, /ArkPlanner 暂不可用/u)
    const unknown = await tool('maa_goal_manager').execute({ action: 'estimate', operators: [{ operator: '清流', targetElite: 2, masteries: [{ skill: 1, target: 3 }] }] }, exec('estimate-unknown'))
    assert.equal(unknown.status, 'needs_input')
    assert.match(unknown.summary, /当前专精等级未知/u)
    const missing = await tool('maa_goal_manager').execute({ action: 'estimate', operator: '不存在' }, exec('estimate-missing'))
    assert.equal(missing.status, 'needs_input')
  } finally {
    globalThis.fetch = original
  }
})

test('recruit high-star results are reported, never auto-confirmed', async () => {
  const { buildTaskDocument, summarizePlan } = await import('../src/commands/planner.js')
  // An empty confirm list means "calculate only" in MaaCore, so the default
  // must actually recruit 3★/4★ and leave 5★/6★ to the player.
  const document = buildTaskDocument([{ type: 'Recruit' }])
  assert.deepEqual(document.tasks[0].params.confirm, [3, 4])
  assert.equal(document.tasks[0].params.times, 4)
  assert.match(summarizePlan([{ type: 'Recruit' }]), /公招4次，自动确认 3\/4★；5★\/6★ 组合不确认/u)
  assert.match(summarizePlan([{ type: 'Recruit', confirm: [3, 6] }]), /⚠ 6★ 也会自动确认/u)
  assert.match(summarizePlan([{ type: 'Recruit', confirm: [] }]), /只会识别、不会招募/u)
  assert.match(summarizePlan([{ type: 'Recruit', times: 0 }]), /只识别 Tag，不招募/u)
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(source, /公招提醒：/u)
})

test('multi-step and Copilot plans get a read-only confirmation panel instead of hanging', async () => {
  await clearPendingPlansForTest()
  const context = exec('multi-step')
  const prepared = await tool('maa_prepare_plan').execute({ purpose: '基建换班并公招', steps: [{ type: 'Infrast' }, { type: 'Recruit', times: 4 }] }, context)
  const maa = commands.find(command => command.name === 'maa')
  const peeked = await maa.handler({ agent: context.agent, rawInput: `peek ${prepared.confirmationCode}`, signal: AbortSignal.timeout(10_000) })
  assert.equal(peeked.kind, 'success')
  const payload = JSON.parse(peeked.text)
  assert.equal(payload.panel.type, 'Plan')
  assert.deepEqual(payload.panel.fields, [])
  assert.deepEqual(payload.panel.values, {})
  assert.equal(payload.panel.notes[0].text, '1. 基建换班')
  assert.match(payload.panel.notes[1].text, /^2\. 自动公招：4次，自动确认 3\/4★/u)
  const single = await tool('maa_prepare_plan').execute({ purpose: '只刷 1-7', steps: [{ type: 'Fight', stage: '1-7', times: 2 }] }, exec('single-step'))
  const singlePeek = JSON.parse((await maa.handler({ agent: { id: 'single-step', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn } }] } }, rawInput: `peek ${single.confirmationCode}`, signal: AbortSignal.timeout(10_000) })).text)
  assert.equal(singlePeek.panel.type, 'Fight')
})

test('one-off panel values are never remembered and leftover generated files are refused', async () => {
  const { taskPanelFromDocument } = await import('../src/commands/task-panel.js')
  const { rememberPanelValues, applyRememberedConfig } = await import('../src/commands/panel-memory.js')
  const { buildTaskDocument } = await import('../src/commands/planner.js')
  const { assertNoGeneratedMarkers } = await import('../src/strategy/compiler.js')
  await rememberPanelValues(taskPanelFromDocument(buildTaskDocument([{ type: 'Infrast', mode: 10000, filename: '__DSH_GENERATED_INFRAST__', facilities: ['Mfg'], drones: 'PureGold' }])))
  const infrast = await applyRememberedConfig(taskPanelFromDocument(buildTaskDocument([{ type: 'Infrast' }])))
  assert.equal(infrast.values.mode, 0)
  assert.equal(infrast.values.filename, '')
  assert.deepEqual(infrast.values.facilities, ['Mfg'])
  const itemIndex = { byId: new Map([['30013', { id: '30013', name: '固源岩组' }]]), byName: new Map() }
  await rememberPanelValues(taskPanelFromDocument(buildTaskDocument([{ type: 'Fight', stage: '1-7', times: 3, drops: { 30013: 3 } }]), undefined, { itemIndex }))
  const fight = await applyRememberedConfig(taskPanelFromDocument(buildTaskDocument([{ type: 'Fight', times: 1 }]), undefined, { itemIndex }))
  assert.equal(fight.values.stage, '1-7')
  assert.equal(fight.values.drops, '')
  assert.throws(() => assertNoGeneratedMarkers({ tasks: [{ type: 'Infrast', params: { filename: '__DSH_GENERATED_INFRAST__' } }] }), /已经不存在/u)
  assert.doesNotThrow(() => assertNoGeneratedMarkers({ tasks: [{ type: 'Infrast', params: { mode: 0 } }] }))
})

test('memories written by the previous version with a generated schedule are ignored', async () => {
  const { writeFile: write } = await import('node:fs/promises')
  const { taskPanelFromDocument } = await import('../src/commands/task-panel.js')
  const { applyRememberedConfig, panelMemoryFilePath } = await import('../src/commands/panel-memory.js')
  const { buildTaskDocument } = await import('../src/commands/planner.js')
  const fresh = taskPanelFromDocument(buildTaskDocument([{ type: 'Infrast' }]))
  const file = panelMemoryFilePath()
  const current = JSON.parse(await readFile(file, 'utf8'))
  const key = 'Panel:Infrast'
  current.entries[key] = { ...fresh.values, mode: 10000, filename: '__DSH_GENERATED_INFRAST__', planIndex: 0, threshold: 0.5 }
  await write(file, JSON.stringify(current))
  const restored = await applyRememberedConfig(fresh)
  assert.equal(restored.values.mode, 0)
  assert.equal(restored.values.filename, '')
  assert.equal(restored.values.threshold, 0.5)
})

test('a plan prepared from natural language shows exactly what was planned, not remembered panel values', async () => {
  const { taskPanelFromDocument } = await import('../src/commands/task-panel.js')
  const { rememberPanelValues, applyRememberedConfig } = await import('../src/commands/panel-memory.js')
  const { buildTaskDocument } = await import('../src/commands/planner.js')
  await rememberPanelValues(taskPanelFromDocument(buildTaskDocument([{ type: 'Fight', stage: 'CE-6', times: 5, medicine: 3 }])))
  await clearPendingPlansForTest()
  const context = exec('nl-plan')
  const prepared = await tool('maa_prepare_plan').execute({ purpose: '刷 1-7', steps: [{ type: 'Fight', stage: '1-7', times: 20 }] }, context)
  const maa = commands.find(command => command.name === 'maa')
  const panel = JSON.parse((await maa.handler({ agent: context.agent, rawInput: `peek ${prepared.confirmationCode}`, signal: AbortSignal.timeout(10_000) })).text).panel
  assert.deepEqual([panel.values.stage, panel.values.times, panel.values.medicine], ['1-7', 20, 0])
  // The zero-model /maa fight panel still prefills from memory.
  const local = await applyRememberedConfig(taskPanelFromDocument(buildTaskDocument([{ type: 'Fight', times: 1 }])))
  assert.deepEqual([local.values.stage, local.values.times], ['CE-6', 5])
})

test('a remembered recognize-only recruit setting from the old defaults no longer disables recruiting', async () => {
  const { taskPanelFromDocument } = await import('../src/commands/task-panel.js')
  const { rememberPanelValues, applyRememberedConfig } = await import('../src/commands/panel-memory.js')
  const { buildTaskDocument } = await import('../src/commands/planner.js')
  await rememberPanelValues(taskPanelFromDocument({ tasks: [{ type: 'Recruit', params: { refresh: true, select: [4, 5, 6], confirm: [], times: 0, set_time: true, expedite: false } }] }))
  const panel = await applyRememberedConfig(taskPanelFromDocument(buildTaskDocument([{ type: 'Recruit' }])))
  assert.deepEqual([panel.values.times, panel.values.confirm, panel.values.refresh], [4, [3, 4], true])
  // A deliberate choice (e.g. times 2, only 4★) is still remembered.
  await rememberPanelValues(taskPanelFromDocument({ tasks: [{ type: 'Recruit', params: { refresh: false, select: [4, 5, 6], confirm: [4], times: 2 } }] }))
  const chosen = await applyRememberedConfig(taskPanelFromDocument(buildTaskDocument([{ type: 'Recruit' }])))
  assert.deepEqual([chosen.values.times, chosen.values.confirm], [2, [4]])
})
