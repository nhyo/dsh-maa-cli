import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { discoverMaaCapabilities, findRoguelikeTheme } from '../src/capabilities/discovery.js'
import { applyRoguelikeOverrides, buildTaskDocument } from '../src/commands/planner.js'
import { taskPanelFromDocument } from '../src/commands/task-panel.js'

const COMPATIBILITY = { cliVersion: '0.7.7', coreVersion: '6.20.1' }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-capabilities-'))
  const resource = path.join(root, 'resource')
  const state = path.join(root, 'state')
  const theme = path.join(resource, 'roguelike', 'BlackFlow')
  await mkdir(path.join(theme, 'encounter'), { recursive: true })
  await mkdir(path.join(resource, 'tasks', 'Roguelike'), { recursive: true })
  await writeFile(path.join(theme, 'recruitment.json'), JSON.stringify({
    theme: 'BlackFlow', priority: [{ name: '核心', opers: [{ name: '机械师' }, { name: '维什戴尔' }] }],
  }))
  await writeFile(path.join(theme, 'shopping.json'), JSON.stringify({ priority: [{ name: '锈蚀的铁锤' }], other: [] }))
  await writeFile(path.join(theme, 'strategy.json'), JSON.stringify({
    rules: [{ when: { fact: 'start_squad', op: 'eq', value: '特勤分队' } }, { when: { fact: 'start_roles', op: 'eq', value: '稳扎稳打' } }],
  }))
  await writeFile(path.join(theme, 'encounter', 'default.json'), JSON.stringify({ stage: [{ name: '吉兆' }] }))
  await writeFile(path.join(resource, 'tasks', 'Roguelike', 'BlackFlow.json'), JSON.stringify({
    'BlackFlow@Roguelike@StrategyChange_mode0': {},
    'BlackFlow@Roguelike@StrategyChange_mode30001': {},
  }))
  await writeFile(path.join(resource, 'stages.json'), JSON.stringify([{ code: '1-7', stageId: 'main_01-07' }]))
  return { root, resource, env: { ...process.env, DSH_MAA_CLI_STATE_DIR: state }, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('discovers one capability descriptor shared by UI and validation', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const capabilities = await discoverMaaCapabilities({ resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  const theme = findRoguelikeTheme(capabilities, 'BlackFlow')
  assert.equal(capabilities.source, 'resource')
  assert.equal(theme.difficulties.at(-1), 16)
  assert.deepEqual(theme.modes.map(item => item.value), [0, 1, 4, 6, 7, 30001])
  assert.ok(theme.operators.includes('维什戴尔'))
  assert.ok(theme.groups.includes('核心'))
  assert.ok(theme.collectibles.includes('锈蚀的铁锤'))
  assert.ok(theme.encounters.names.includes('吉兆'))
  assert.equal(capabilities.maps.stages.includes('1-7'), true)

  const document = buildTaskDocument([{ type: 'Roguelike', theme: 'BlackFlow', startsCount: 1, difficulty: 16 }], capabilities)
  const panel = taskPanelFromDocument(document, capabilities)
  const difficulty = panel.fields.find(field => field.key === 'difficulty')
  assert.ok(difficulty.options.some(option => option.value === 16 && option.when.in.includes('BlackFlow')))
  assert.equal(applyRoguelikeOverrides(document, { difficulty: '16' }, capabilities).document.tasks[0].params.difficulty, 16)
  assert.throws(() => applyRoguelikeOverrides(document, { difficulty: '17' }, capabilities), /不支持难度/u)
  assert.equal(buildTaskDocument([{ type: 'Roguelike', startsCount: 1 }], capabilities).tasks[0].params.theme, 'BlackFlow')
})

test('resource additions and removals change the signature and options without a restart', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const recruitment = path.join(env.resource, 'roguelike', 'BlackFlow', 'recruitment.json')
  const first = await discoverMaaCapabilities({ resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  await writeFile(recruitment, JSON.stringify({ theme: 'BlackFlow', priority: [{ name: '新组', opers: [{ name: '新干员名称加长' }] }] }))
  const second = await discoverMaaCapabilities({ resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  assert.notEqual(second.signature, first.signature)
  assert.equal(findRoguelikeTheme(second, 'BlackFlow').operators.includes('新干员名称加长'), true)
  assert.equal(findRoguelikeTheme(second, 'BlackFlow').operators.includes('维什戴尔'), false)
})

test('new resource-only themes and modes appear and disappear without an adapter change', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const theme = path.join(env.resource, 'roguelike', 'FutureTheme')
  const task = path.join(env.resource, 'tasks', 'Roguelike', 'FutureTheme.json')
  await mkdir(theme, { recursive: true })
  await writeFile(task, JSON.stringify({
    'FutureTheme@Roguelike@StrategyChange_mode4242': {},
  }))

  const added = await discoverMaaCapabilities({ resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  assert.deepEqual(findRoguelikeTheme(added, 'FutureTheme').modes, [{ value: 4242, label: 'mode 4242' }])
  const futureDocument = buildTaskDocument([{ type: 'Roguelike', theme: 'FutureTheme', startsCount: 1, mode: 4242 }], added)
  const futurePanel = taskPanelFromDocument(futureDocument, added)
  assert.ok(futurePanel.fields.find(field => field.key === 'theme').options.some(option => option.value === 'FutureTheme'))
  assert.equal(futurePanel.values.squad, '')
  assert.equal(futurePanel.values.roles, '')
  assert.equal(futurePanel.values.coreChar, '')
  assert.equal(futurePanel.fields.find(field => field.key === 'squad').required, false)
  const confirmed = applyRoguelikeOverrides(futureDocument, {
    theme: 'FutureTheme', mode: '4242', difficulty: '0', startsCount: '1',
  }, added).document.tasks[0].params
  assert.equal('squad' in confirmed, false)
  assert.equal('roles' in confirmed, false)
  assert.equal('core_char' in confirmed, false)

  const noModes = structuredClone(added)
  findRoguelikeTheme(noModes, 'FutureTheme').modes = []
  const incompletePanel = taskPanelFromDocument({ tasks: [{ type: 'Roguelike', params: { theme: 'FutureTheme', starts_count: 1 } }] }, noModes)
  assert.equal(incompletePanel.fields.find(field => field.key === 'mode').required, true)
  assert.equal(incompletePanel.values.mode, undefined)
  assert.throws(
    () => applyRoguelikeOverrides(futureDocument, { mode: '' }, noModes),
    /肉鸽模式无效/u,
  )

  await rm(theme, { recursive: true })
  await rm(task)
  const removed = await discoverMaaCapabilities({ resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  assert.equal(findRoguelikeTheme(removed, 'FutureTheme'), null)
  assert.notEqual(removed.signature, added.signature)
})

test('a broken update retains the last verified capability cache', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const first = await discoverMaaCapabilities({ resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  await writeFile(path.join(env.resource, 'roguelike', 'BlackFlow', 'recruitment.json'), '{broken')
  const fallback = await discoverMaaCapabilities({ resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env, force: true })
  assert.equal(fallback.signature, first.signature)
  assert.equal(fallback.stale, true)
  assert.match(fallback.warning, /沿用上次已验证缓存/u)
})
