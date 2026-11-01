import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildTaskDocument } from '../src/commands/planner.js'
import { parseLocalMaaCommand } from '../src/commands/local-command.js'
import { taskPanelFromDocument } from '../src/commands/task-panel.js'
import { applyRememberedConfig, clearPanelMemory, panelMemoryFilePath, readPanelMemory, rememberPanelValues } from '../src/commands/panel-memory.js'

async function tempEnv(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'maa-panel-memory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { DSH_MAA_CLI_STATE_DIR: directory }
}

function commandPanel(command) {
  const parsed = parseLocalMaaCommand(command)
  return taskPanelFromDocument(buildTaskDocument(parsed.steps))
}

function roguelikePanel(theme) {
  return taskPanelFromDocument(buildTaskDocument([{ type: 'Roguelike', theme, startsCount: 9999 }]))
}

function scopedOption(panel, key, theme) {
  return panel.fields.find(field => field.key === key).options.find(option => option.when?.in?.includes(theme))
}

test('remembers every parameter kind for every parameterized command', async (t) => {
  const env = await tempEnv(t)
  const cases = [
    ['startup', { clientType: 'Bilibili', startGameEnabled: false, accountName: 'masked-account' }],
    ['fight', { stage: 'AP-5', times: 7, medicine: 2, medicineExpireDays: 4, stone: 0, drGrandet: true }],
    ['infrast', { facilities: ['Mfg', 'Trade'], drones: 'Money', threshold: 0.55, replenish: true, dormTrust: true }],
    ['recruit', { refresh: true, select: [3, 4, 5], confirm: [4, 5], times: 3, expedite: true, firstTags: '先锋干员;费用回复', preserveTags: '' }],
    ['mall', { visitFriends: false, shopping: true, buyFirst: '招聘许可;技巧概要·卷1', blacklist: '', onlyBuyDiscount: true }],
    ['award', { dailyWeekly: true, mail: true, freePull: false, orundum: true }],
    ['reclamation', { theme: 'Tales', mode: 1, toolToCraft: '荧光棒;蟹蟹抽水泵', numCraftBatches: 8, incrementMode: 1 }],
    ['update', { updateOperBox: false, updateDepot: true }],
  ]
  for (const [command, changes] of cases) {
    const panel = commandPanel(command)
    panel.values = { ...panel.values, ...changes }
    assert.equal(await rememberPanelValues(panel, { env }), `Panel:${panel.type}`)
    const restored = await applyRememberedConfig(commandPanel(command), { env })
    assert.equal(restored.remembered, true, command)
    for (const [key, value] of Object.entries(changes)) assert.deepEqual(restored.values[key], value, `${command}.${key}`)
  }
})

test('keeps command preferences independent', async (t) => {
  const env = await tempEnv(t)
  const fight = commandPanel('fight')
  fight.values = { ...fight.values, stage: '1-7', times: 9 }
  await rememberPanelValues(fight, { env })
  const recruit = commandPanel('recruit')
  recruit.values = { ...recruit.values, times: 4 }
  await rememberPanelValues(recruit, { env })
  assert.equal((await applyRememberedConfig(commandPanel('fight'), { env })).values.times, 9)
  assert.equal((await applyRememberedConfig(commandPanel('recruit'), { env })).values.times, 4)
})

test('serializes concurrent confirmations without losing another command entry', async (t) => {
  const env = await tempEnv(t)
  const fight = commandPanel('fight'); fight.values = { ...fight.values, times: 11 }
  const mall = commandPanel('mall'); mall.values = { ...mall.values, blacklist: '' }
  await Promise.all([rememberPanelValues(fight, { env }), rememberPanelValues(mall, { env })])
  const memory = await readPanelMemory(env)
  assert.equal(memory.entries['Panel:Fight'].times, 11)
  assert.equal(memory.entries['Panel:Mall'].blacklist, '')
})

test('remembers each roguelike theme and the last confirmed theme independently', async (t) => {
  const env = await tempEnv(t)
  const jie = roguelikePanel('JieGarden')
  const jieSquad = scopedOption(jie, 'squad', 'JieGarden')
  const jieOper = scopedOption(jie, 'coreChar', 'JieGarden')
  jie.values = { ...jie.values, startsCount: 1, useSupport: true, stopAtMaxLevel: true, ...(jieSquad ? { squad: jieSquad.value } : {}), ...(jieOper ? { coreChar: jieOper.value } : {}) }
  await rememberPanelValues(jie, { env })

  const sami = roguelikePanel('Sami')
  const samiOper = scopedOption(sami, 'coreChar', 'Sami')
  sami.values = { ...sami.values, startsCount: 8, useSupport: false, investmentsCount: 17, ...(samiOper ? { coreChar: samiOper.value } : {}) }
  await rememberPanelValues(sami, { env })

  let opened = await applyRememberedConfig(roguelikePanel('Phantom'), { env })
  assert.equal(opened.values.theme, 'Sami')
  assert.equal(opened.values.startsCount, 8)
  assert.equal(opened.preferenceVariants.JieGarden.startsCount, 1)
  assert.equal(opened.preferenceVariants.Sami.investmentsCount, 17)

  await rememberPanelValues(jie, { env })
  opened = await applyRememberedConfig(roguelikePanel('Phantom'), { env })
  assert.equal(opened.values.theme, 'JieGarden')
  assert.equal(opened.values.startsCount, 1)
  assert.equal(opened.preferenceVariants.Sami.investmentsCount, 17)
})

test('explicit command values override history without erasing other fields', async (t) => {
  const env = await tempEnv(t)
  const fight = commandPanel('fight')
  fight.values = { ...fight.values, stage: '1-7', times: 9, medicine: 2, stone: 0 }
  await rememberPanelValues(fight, { env })
  const applied = await applyRememberedConfig(commandPanel('fight AP-5 2'), { env, explicitKeys: ['stage', 'times'] })
  assert.equal(applied.values.stage, 'AP-5')
  assert.equal(applied.values.times, 2)
  assert.equal(applied.values.medicine, 2)
  assert.equal((await readPanelMemory(env)).entries['Panel:Fight'].stage, '1-7')

  const jie = roguelikePanel('JieGarden'); jie.values = { ...jie.values, startsCount: 6 }; await rememberPanelValues(jie, { env })
  const sami = roguelikePanel('Sami'); sami.values = { ...sami.values, startsCount: 3 }; await rememberPanelValues(sami, { env })
  const explicitTheme = await applyRememberedConfig(roguelikePanel('JieGarden'), { env, explicitKeys: ['theme'] })
  assert.equal(explicitTheme.values.theme, 'JieGarden')
  assert.equal(explicitTheme.values.startsCount, 6)
})

test('invalid remembered fields fall back individually after a capability change', async (t) => {
  const env = await tempEnv(t)
  const panel = roguelikePanel('Sarkaz')
  panel.values = { ...panel.values, startsCount: 5, useSupport: true }
  await rememberPanelValues(panel, { env })
  const memory = await readPanelMemory(env)
  memory.entries['Roguelike:Sarkaz'].difficulty = 999
  memory.entries['Roguelike:Sarkaz'].startsCount = 0
  await writeFile(panelMemoryFilePath(env), `${JSON.stringify(memory)}\n`)
  const applied = await applyRememberedConfig(roguelikePanel('Sarkaz'), { env, explicitKeys: ['theme'] })
  assert.notEqual(applied.values.difficulty, 999)
  assert.equal(applied.values.startsCount, 9999)
  assert.equal(applied.values.useSupport, true)
})

test('reads v1 memory and writes v2 on the next confirmation', async (t) => {
  const env = await tempEnv(t)
  await writeFile(panelMemoryFilePath(env), `${JSON.stringify({ version: 1, entries: { 'Roguelike:Sarkaz': { startsCount: 5, useSupport: true } } })}\n`)
  const migrated = await readPanelMemory(env)
  assert.equal(migrated.version, 2)
  assert.equal(migrated.entries['Roguelike:Sarkaz'].startsCount, 5)
  const applied = await applyRememberedConfig(roguelikePanel('Sarkaz'), { env, explicitKeys: ['theme'] })
  assert.equal(applied.values.startsCount, 5)
  await rememberPanelValues(applied, { env })
  assert.equal(JSON.parse(await readFile(panelMemoryFilePath(env), 'utf8')).version, 2)
})

test('unconfirmed edits never mutate persistent memory', async (t) => {
  const env = await tempEnv(t)
  const confirmed = commandPanel('mall')
  confirmed.values = { ...confirmed.values, buyFirst: '招聘许可', blacklist: '碳' }
  await rememberPanelValues(confirmed, { env })
  const draft = await applyRememberedConfig(commandPanel('mall'), { env })
  draft.values.buyFirst = '家具'; draft.values.blacklist = ''
  const reopened = await applyRememberedConfig(commandPanel('mall'), { env })
  assert.equal(reopened.values.buyFirst, '招聘许可')
  assert.equal(reopened.values.blacklist, '碳')
})

test('clears preferences and tolerates a corrupt file', async (t) => {
  const env = await tempEnv(t)
  await rememberPanelValues(commandPanel('fight'), { env })
  await clearPanelMemory(env)
  assert.deepEqual((await readPanelMemory(env)).entries, {})
  await writeFile(panelMemoryFilePath(env), '{broken')
  assert.deepEqual(await readPanelMemory(env), { version: 2, entries: {}, lastRoguelikeTheme: '' })
})
