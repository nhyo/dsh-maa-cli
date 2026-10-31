import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  compileStrategyRequest,
  GENERATED_COPILOT_MARKER,
  materializeStrategy,
  previewStrategy,
  recoverStrategyOverlay,
} from '../src/strategy/compiler.js'
import { parseStrategyNote } from '../src/strategy/note.js'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-strategy-'))
  const resource = path.join(root, 'resource')
  const config = path.join(root, 'config')
  const theme = path.join(resource, 'roguelike', 'Sami')
  await mkdir(path.join(theme, 'encounter'), { recursive: true })
  await mkdir(path.join(resource, 'Arknights-Tile-Pos'), { recursive: true })
  await mkdir(config, { recursive: true })
  await writeFile(path.join(theme, 'recruitment.json'), JSON.stringify({
    theme: 'Sami',
    priority: [
      { name: '高台C', opers: [{ name: '维什戴尔', skill: 3, recruit_priority: 900, promote_priority: 800 }] },
      { name: '回费', opers: [{ name: '桃金娘', skill: 1, recruit_priority: 500, promote_priority: 100 }] },
    ],
    team_complete_condition: [{ groups: ['高台C'], threshold: 1 }],
  }, null, 2))
  await writeFile(path.join(theme, 'shopping.json'), JSON.stringify({
    theme: 'Sami',
    priority: [{ name: '锈蚀的铁锤' }, { name: '人事部密信' }, { name: '坏藏品' }],
    other: [{ doc: '不会主动购买的藏品' }],
  }, null, 2))
  await writeFile(path.join(theme, 'encounter', 'default.json'), JSON.stringify({
    theme: 'Sami', stage: [{ name: '吉兆', option_num: 2, choose: 2 }],
  }, null, 2))
  await writeFile(path.join(theme, 'encounter', 'deposit.json'), JSON.stringify({
    theme: 'Sami', mode: [1, 4], stage: [{ name: '投资事件', option_num: 2, choose: 1 }],
  }, null, 2))
  await writeFile(path.join(resource, 'stages.json'), JSON.stringify([{ code: 'T-1', stageId: 'test_stage' }]))
  await writeFile(path.join(resource, 'Arknights-Tile-Pos', 'test_stage-test.json'), JSON.stringify({
    code: 'T-1', stageId: 'test_stage', width: 5, height: 3,
    tiles: [
      [{ buildableType: 0 }, { buildableType: 0 }, { buildableType: 0 }, { buildableType: 0 }, { buildableType: 0 }],
      [
        { buildableType: 0, isStart: true },
        { buildableType: 1 }, { buildableType: 1 }, { buildableType: 1 },
        { buildableType: 0, isEnd: true },
      ],
      [{ buildableType: 0 }, { buildableType: 0 }, { buildableType: 0 }, { buildableType: 0 }, { buildableType: 0 }],
    ],
  }))
  return { root, resource, config, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('compiles native roguelike priorities into user resources and restores them', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const strategy = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami', startsCount: 2 },
    recruitment: {
      prioritize: [{ name: '维什戴尔', priority: 4321 }],
      promote: [{ name: '桃金娘', priority: 3456 }],
      teamComplete: [{ groups: ['高台C', '回费'], threshold: 2 }],
    },
    shopping: { prioritize: ['人事部密信'], avoid: ['坏藏品'] },
    encounters: [{ name: '吉兆', choose: 1 }],
  })
  const preview = await previewStrategy(strategy, env.resource)
  assert.deepEqual(preview.unsupported, [])
  assert.ok(preview.supported.includes('优先招募 维什戴尔'))
  const recruitmentFile = path.join(env.resource, 'roguelike', 'Sami', 'recruitment.json')
  const shoppingFile = path.join(env.resource, 'roguelike', 'Sami', 'shopping.json')
  const eventFile = path.join(env.resource, 'roguelike', 'Sami', 'encounter', 'default.json')
  const originals = await Promise.all([recruitmentFile, shoppingFile, eventFile].map(file => readFile(file, 'utf8')))
  const existingUserResource = `${JSON.stringify({ user_custom_resource: true }, null, 2)}\n`
  const existingUserFile = path.join(env.config, 'resource', 'roguelike', 'Sami', 'recruitment.json')
  await mkdir(path.dirname(existingUserFile), { recursive: true })
  await writeFile(existingUserFile, existingUserResource)
  const materialized = await materializeStrategy({ tasks: [{ type: 'Roguelike', params: { theme: 'Sami' } }] }, strategy, { resourceDir: env.resource, configDir: env.config })
  const overlayBase = path.join(env.config, 'resource', 'roguelike', 'Sami')
  const overlayFiles = [path.join(overlayBase, 'recruitment.json'), path.join(overlayBase, 'shopping.json'), path.join(overlayBase, 'encounter', 'default.json')]
  const recruitment = JSON.parse(await readFile(overlayFiles[0], 'utf8'))
  const shopping = JSON.parse(await readFile(overlayFiles[1], 'utf8'))
  const encounter = JSON.parse(await readFile(overlayFiles[2], 'utf8'))
  assert.equal(materialized.userResource, true)
  assert.equal(recruitment.priority[0].opers[0].recruit_priority, 4321)
  assert.equal(recruitment.priority[1].opers[0].promote_priority, 3456)
  assert.deepEqual(recruitment.team_complete_condition, [{ groups: ['高台C', '回费'], threshold: 2 }])
  assert.equal(shopping.priority[0].name, '人事部密信')
  assert.equal(shopping.priority.some(item => item.name === '坏藏品'), false)
  assert.equal(encounter.stage[0].choose, 1)
  await materialized.restore()
  const restored = await Promise.all([recruitmentFile, shoppingFile, eventFile].map(file => readFile(file, 'utf8')))
  assert.deepEqual(restored, originals)
  assert.equal(await readFile(overlayFiles[0], 'utf8'), existingUserResource)
  await assert.rejects(readFile(overlayFiles[1], 'utf8'), /ENOENT/)
})

async function fixtureAutopilot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-strategy-autopilot-'))
  const resource = path.join(root, 'resource')
  const config = path.join(root, 'config')
  const theme = path.join(resource, 'roguelike', 'Sami')
  await mkdir(path.join(theme, 'autopilot'), { recursive: true })
  await mkdir(config, { recursive: true })
  await writeFile(path.join(theme, 'recruitment.json'), JSON.stringify({
    theme: 'Sami',
    priority: [
      { name: '高台C', opers: [{ name: '维什戴尔', skill: 3, recruit_priority: 900, promote_priority: 800 }] },
      { name: '回费', opers: [{ name: '桃金娘', skill: 1, recruit_priority: 500, promote_priority: 100 }] },
    ],
    team_complete_condition: [{ groups: ['高台C'], threshold: 1 }],
  }, null, 2))
  await writeFile(path.join(theme, 'autopilot', '暗箭难防.json'), JSON.stringify({
    stage_name: '暗箭难防',
    replacement_home: [{ location: [9, 1], direction: 'down' }],
    blacklist_location: [],
    deploy_plan: [{ groups: ['高台C'], location: [3, 2], direction: 'down' }],
  }, null, 2))
  await writeFile(path.join(resource, 'battle_data.json'), JSON.stringify({
    chars: {
      char_4217_makoto: { name: '结城理', name_en: 'Makoto Yuki', position: 'MELEE', profession: 'SPECIAL', rarity: 6 },
      char_2014_vanguard: { name: '维什戴尔', name_en: "Wiš'adel", position: 'RANGED', profession: 'CASTER', rarity: 6 },
    },
  }, null, 2))
  return { root, resource, config, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function fixtureWildcard() {
  const env = await fixtureAutopilot()
  const theme = path.join(env.resource, 'roguelike', 'Sami')
  const tileDir = path.join(env.resource, 'Arknights-Tile-Pos')
  await mkdir(tileDir, { recursive: true })
  await writeFile(path.join(tileDir, 'overview.json'), JSON.stringify([
    { code: 'S1', filename: 's1.json', name: '暗箭难防' },
    { code: 'S2', filename: 's2.json', name: '二号关卡' },
  ], null, 2))
  const tiles = [
    [{ buildableType: 0 }, { buildableType: 1 }, { buildableType: 2, heightType: 1 }],
    [{ buildableType: 0, isStart: true }, { buildableType: 1 }, { buildableType: 2, heightType: 1 }],
    [{ buildableType: 0 }, { buildableType: 1 }, { buildableType: 0, isEnd: true }],
  ]
  for (const filename of ['s1.json', 's2.json']) await writeFile(path.join(tileDir, filename), JSON.stringify({ tiles }, null, 2))
  await writeFile(path.join(theme, 'autopilot', '二号关卡.json'), JSON.stringify({
    stage_name: '二号关卡',
    replacement_home: [{ location: [0, 0], direction: 'down' }],
    blacklist_location: [],
    deploy_plan: [],
  }, null, 2))
  await writeFile(path.join(theme, 'autopilot', '无地图关卡.json'), JSON.stringify({
    stage_name: '无地图关卡',
    replacement_home: [],
    blacklist_location: [],
    deploy_plan: [],
  }, null, 2))
  return env
}

test('synthesizes a missing operator group and writes a roguelike block tactic into the autopilot file MAA uses', async t => {
  const env = await fixtureAutopilot()
  t.after(env.cleanup)
  const strategy = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami' },
    recruitment: { prioritize: [{ name: '结城理' }] },
    tactics: [{ kind: 'block_entrance', name: '结城理', stageName: '暗箭难防', location: [3, 1], direction: '下' }],
  })
  const preview = await previewStrategy(strategy, env.resource)
  assert.deepEqual(preview.unsupported, [])
  assert.ok(preview.supported.includes('优先招募 结城理（新增分组 结城理）'))
  assert.ok(preview.supported.includes('堵门：结城理 @ 暗箭难防 [3,1] down'))

  const materialized = await materializeStrategy(
    { tasks: [{ type: 'Roguelike', params: { theme: 'Sami' } }] }, strategy,
    { resourceDir: env.resource, configDir: env.config },
  )
  const overlayBase = path.join(env.config, 'resource', 'roguelike', 'Sami')
  const recruitment = JSON.parse(await readFile(path.join(overlayBase, 'recruitment.json'), 'utf8'))
  const created = recruitment.priority.find(group => group.name === '结城理')
  assert.deepEqual(created, {
    name: '结城理',
    opers: [{ name: '结城理', skill: 1, is_key: false, is_start: false, recruit_priority: 2000, promote_priority: 2000 }],
  })
  const autopilot = JSON.parse(await readFile(path.join(overlayBase, 'autopilot', '暗箭难防.json'), 'utf8'))
  assert.deepEqual(autopilot.replacement_home, [{ location: [9, 1], direction: 'down' }])
  assert.deepEqual(autopilot.deploy_plan.at(-1), { groups: ['结城理'], location: [3, 1], direction: 'down' })
  await materialized.restore()
  await assert.rejects(readFile(path.join(overlayBase, 'autopilot', '暗箭难防.json'), 'utf8'), /ENOENT/)
})

test('rejects a roguelike tactic without map data, coordinates or facing', async t => {
  const env = await fixtureAutopilot()
  t.after(env.cleanup)
  const strategy = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami' },
    tactics: [
      { kind: 'block_entrance', name: '结城理' },
      { kind: 'guard_blue', name: '结城理', stageName: '暗箭难防' },
      { kind: 'guard_blue', name: '结城理', stageName: '暗箭难防', location: [3, 1] },
    ],
  })
  const preview = await previewStrategy(strategy, env.resource)
  assert.equal(preview.unsupported.length, 3)
  assert.match(preview.unsupported.map(item => item.reason).join('\n'), /地图数据|部署坐标|部署朝向/u)
})

test('applies a stage-less tactic to every native autopilot stage by deriving positions from the map', async t => {
  const env = await fixtureWildcard()
  t.after(env.cleanup)
  const strategy = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami' },
    tactics: [{ kind: 'block_entrance', name: '结城理' }],
  })
  const preview = await previewStrategy(strategy, env.resource)
  assert.equal(preview.unsupported.length, 1, JSON.stringify(preview.unsupported))
  assert.match(preview.unsupported[0].reason, /缺少地图数据|可部署落点/u)
  assert.ok(preview.supported.some(line => line.includes('全部 2 个原生关卡')), preview.supported.join('\n'))

  const materialized = await materializeStrategy(
    { tasks: [{ type: 'Roguelike', params: { theme: 'Sami' } }] }, strategy,
    { resourceDir: env.resource, configDir: env.config },
  )
  const overlayBase = path.join(env.config, 'resource', 'roguelike', 'Sami')
  for (const name of ['暗箭难防', '二号关卡']) {
    const autopilot = JSON.parse(await readFile(path.join(overlayBase, 'autopilot', `${name}.json`), 'utf8'))
    assert.deepEqual(autopilot.deploy_plan.at(-1), { groups: ['结城理'], location: [1, 1], direction: 'left' })
  }
  await assert.rejects(readFile(path.join(overlayBase, 'autopilot', '无地图关卡.json'), 'utf8'), /ENOENT/)
  await materialized.restore()

  const ranged = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami' },
    tactics: [{ kind: 'block_entrance', name: '维什戴尔' }],
  })
  const rangedPreview = await previewStrategy(ranged, env.resource)
  assert.equal(rangedPreview.unsupported.length, 1, JSON.stringify(rangedPreview.unsupported))
  const rangedDeploy = await materializeStrategy(
    { tasks: [{ type: 'Roguelike', params: { theme: 'Sami' } }] }, ranged,
    { resourceDir: env.resource, configDir: env.config },
  )
  const highGround = JSON.parse(await readFile(path.join(overlayBase, 'autopilot', '暗箭难防.json'), 'utf8'))
  assert.deepEqual(highGround.deploy_plan.at(-1), { groups: ['高台C'], location: [2, 1], direction: 'left' })
  await rangedDeploy.restore()
})

test('routes a natural-language note end to end into the autopilot and recruitment resources', async t => {
  const env = await fixtureAutopilot()
  t.after(env.cleanup)
  const currentDir = process.env.DSH_MAA_CLI_STATE_DIR
  process.env.DSH_MAA_CLI_STATE_DIR = path.join(env.root, 'state')
  t.after(() => {
    if (currentDir === undefined) delete process.env.DSH_MAA_CLI_STATE_DIR
    else process.env.DSH_MAA_CLI_STATE_DIR = currentDir
  })
  const pending = { document: { tasks: [{ type: 'Roguelike', params: { theme: 'Sami', mode: 0, starts_count: 1 } }] } }
  const parsed = await parseStrategyNote('优先抓结城理，并在暗箭难防让结城理堵门 [3,1] 朝下', pending)
  assert.equal(parsed.needsModel, false)
  const strategy = compileStrategyRequest(parsed.input)
  const preview = await previewStrategy(strategy, env.resource)
  assert.deepEqual(preview.unsupported, [])
  const materialized = await materializeStrategy(pending.document, strategy, { resourceDir: env.resource, configDir: env.config })
  const overlayBase = path.join(env.config, 'resource', 'roguelike', 'Sami')
  const recruitment = JSON.parse(await readFile(path.join(overlayBase, 'recruitment.json'), 'utf8'))
  assert.equal(recruitment.priority.some(group => group.opers.some(operator => operator.name === '结城理')), true)
  const autopilot = JSON.parse(await readFile(path.join(overlayBase, 'autopilot', '暗箭难防.json'), 'utf8'))
  assert.deepEqual(autopilot.deploy_plan.at(-1), { groups: ['结城理'], location: [3, 1], direction: 'down' })
  await materialized.restore()
})

test('keeps the whole theme recruitment table and finds a stage by its stage_name field', async t => {
  const env = await fixtureAutopilot()
  t.after(env.cleanup)
  const theme = path.join(env.resource, 'roguelike', 'Sami')
  await rm(path.join(theme, 'autopilot', '暗箭难防.json'))
  await writeFile(path.join(theme, 'autopilot', 'stage-alias.json'), JSON.stringify({
    stage_name: '暗箭难防',
    replacement_home: [{ location: [9, 1], direction: 'down' }],
    blacklist_location: [],
    deploy_plan: [{ groups: ['高台C'], location: [3, 2], direction: 'down' }],
  }, null, 2))
  const strategy = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami' },
    recruitment: { prioritize: [{ name: '结城理' }] },
    tactics: [{ kind: 'guard_blue', name: '结城理', stageName: '暗箭难防', location: [9, 1], direction: '下' }],
  })
  const materialized = await materializeStrategy(
    { tasks: [{ type: 'Roguelike', params: { theme: 'Sami' } }] }, strategy,
    { resourceDir: env.resource, configDir: env.config },
  )
  const overlayBase = path.join(env.config, 'resource', 'roguelike', 'Sami')
  const recruitment = JSON.parse(await readFile(path.join(overlayBase, 'recruitment.json'), 'utf8'))
  assert.deepEqual(recruitment.priority.map(group => group.name).slice(0, 3), ['结城理', '高台C', '回费'])
  assert.deepEqual(recruitment.team_complete_condition, [{ groups: ['高台C'], threshold: 1 }])
  const autopilot = JSON.parse(await readFile(path.join(overlayBase, 'autopilot', 'stage-alias.json'), 'utf8'))
  assert.equal(autopilot.stage_name, '暗箭难防')
  assert.deepEqual(autopilot.deploy_plan.at(-1), { groups: ['结城理'], location: [9, 1], direction: 'down' })
  await materialized.restore()
})

test('recovers an interrupted roguelike overlay before another run', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const strategy = compileStrategyRequest({ kind: 'Roguelike', task: { theme: 'Sami' }, shopping: { avoid: ['坏藏品'] } })
  const file = path.join(env.resource, 'roguelike', 'Sami', 'shopping.json')
  const original = await readFile(file, 'utf8')
  const overlay = path.join(env.config, 'resource', 'roguelike', 'Sami', 'shopping.json')
  await materializeStrategy({ tasks: [{ type: 'Roguelike', params: { theme: 'Sami' } }] }, strategy, { resourceDir: env.resource, configDir: env.config })
  assert.notEqual(await readFile(overlay, 'utf8'), original)
  assert.equal(await readFile(file, 'utf8'), original)
  assert.equal(await recoverStrategyOverlay(env.config), true)
  assert.equal(await readFile(file, 'utf8'), original)
  await assert.rejects(readFile(overlay, 'utf8'), /ENOENT/)
})

test('uses the event strategy file selected by the roguelike mode', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const strategy = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami', mode: 1 },
    encounters: [{ name: '投资事件', choose: 2 }],
  })
  const preview = await previewStrategy(strategy, env.resource)
  assert.deepEqual(preview.unsupported, [])
  const materialized = await materializeStrategy({ tasks: [{ type: 'Roguelike', params: { theme: 'Sami', mode: 1 } }] }, strategy, { resourceDir: env.resource, configDir: env.config })
  const overlay = path.join(env.config, 'resource', 'roguelike', 'Sami', 'encounter', 'deposit.json')
  assert.equal(JSON.parse(await readFile(overlay, 'utf8')).stage[0].choose, 2)
  await materialized.restore()
  await assert.rejects(readFile(overlay, 'utf8'), /ENOENT/)
})

test('generates a real copilot job with tactical map positions and kill triggers', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const strategy = compileStrategyRequest({
    kind: 'Copilot', task: { stageName: 'T-1', formation: true },
    operators: [{ name: '山', skill: 2, skillUsage: 2 }],
    tactics: [{ kind: 'block_entrance', name: '山', kills: 3 }, { kind: 'guard_blue', name: '塞雷娅', kills: 10 }],
    actions: [
      { type: 'Retreat', name: '山', kills: 20 },
      { type: 'Deploy', name: '塞雷娅', location: [2, 1], direction: '右', kills: 21 },
    ],
  })
  const preview = await previewStrategy(strategy, env.resource)
  assert.equal(preview.unsupported.length, 0)
  const materialized = await materializeStrategy({ tasks: [{ type: 'Copilot', params: { filename: GENERATED_COPILOT_MARKER, formation: true } }] }, strategy, { resourceDir: env.resource, configDir: env.config })
  const filename = materialized.document.tasks[0].params.filename
  const job = JSON.parse(await readFile(filename, 'utf8'))
  assert.equal(path.isAbsolute(filename), true)
  assert.equal(job.stage_name, 'T-1')
  assert.deepEqual(job.actions.slice(0, 2), [
    { type: 'Deploy', name: '山', location: [1, 1], direction: 'Left', kills: 3 },
    { type: 'Deploy', name: '塞雷娅', location: [3, 1], direction: 'Left', kills: 10 },
  ])
  assert.deepEqual(job.actions.slice(2).map(action => [action.type, action.kills]), [['Retreat', 20], ['Deploy', 21]])
  assert.equal(job.opers[0].skill_usage, 2)
})

test('reports unsupported native names without inventing resource entries', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const strategy = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami' },
    recruitment: { prioritize: [{ name: '不存在的干员' }], teamComplete: [{ groups: ['不存在的组'], threshold: 1 }] },
    shopping: { prioritize: ['不存在的藏品'] },
    encounters: [{ name: '不存在的事件', choose: 1 }],
  })
  const preview = await previewStrategy(strategy, env.resource)
  assert.equal(preview.supported[0], '切换肉鸽主题 Sami')
  assert.equal(preview.unsupported.length, 4)
  assert.match(preview.unsupported.map(item => item.reason).join('\n'), /没有该干员|不存在的原生分组|没有该物品|没有该事件/u)
})

test('generated files replace plan markers, reject unknown markers and are removed afterwards', async t => {
  const { generatedFileMarker, materializeGeneratedFiles } = await import('../src/strategy/compiler.js')
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-generated-files-'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const marker = generatedFileMarker('copilot-site-42')
  assert.equal(marker, '__DSH_GENERATED_COPILOT_SITE_42__')
  const document = { tasks: [{ type: 'Copilot', params: { copilot_list: [{ filename: marker, stage_name: '1-7' }] } }] }
  const result = await materializeGeneratedFiles(document, [{ marker, content: { stage_name: '1-7', actions: [] } }], { configDir })
  const target = result.document.tasks[0].params.copilot_list[0].filename
  assert.ok(path.isAbsolute(target))
  assert.equal(JSON.parse(await readFile(target, 'utf8')).stage_name, '1-7')
  assert.equal(document.tasks[0].params.copilot_list[0].filename, marker)
  await result.restore()
  await assert.rejects(readFile(target, 'utf8'), /ENOENT/u)
  await assert.rejects(materializeGeneratedFiles({ tasks: [{ type: 'Infrast', params: { filename: '__DSH_GENERATED_INFRAST__' } }] }, [{ marker, content: {} }], { configDir }), /不存在的生成文件/u)
})
