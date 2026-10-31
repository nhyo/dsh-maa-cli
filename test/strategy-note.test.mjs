import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { compileStrategyRequest } from '../src/strategy/compiler.js'
import { applyStrategyMemory } from '../src/strategy/memory.js'
import { noteModelPrompt, parseStrategyNote } from '../src/strategy/note.js'

const COMPATIBILITY = { cliVersion: '0.7.7', coreVersion: '6.20.1' }

function pendingRogue() {
  return { document: { tasks: [{ type: 'Roguelike', params: { theme: 'Sami', mode: 1, starts_count: 3 } }] } }
}

function pendingFight(stage = 'T-1') {
  return { document: { tasks: [{ type: 'Fight', params: { stage, times: 1 } }] } }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-'))
  const resource = path.join(root, 'resource')
  await mkdir(path.join(resource, 'Arknights-Tile-Pos'), { recursive: true })
  await writeFile(path.join(resource, 'stages.json'), JSON.stringify([{ code: 'T-1', stageId: 'test_1' }]))
  await writeFile(path.join(resource, 'Arknights-Tile-Pos', 'test_1-map.json'), JSON.stringify({
    code: 'T-1', stageId: 'test_1',
    tiles: [[{ buildableType: 0, isStart: true }, { buildableType: 1 }, { buildableType: 0, isEnd: true }]],
  }))
  const env = { ...process.env, DSH_MAA_CLI_STATE_DIR: path.join(root, 'state') }
  return { root, resource, env, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('splits a multi-intent roguelike note into executable atomic requests', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-parse-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = await parseStrategyNote(
    '优先招募维什戴尔用三技能，同时优先精二维什戴尔，不买不灭的火炬，吉兆选第1项',
    pendingRogue(), { env: { ...process.env, DSH_MAA_CLI_STATE_DIR: root } },
  )

  assert.equal(parsed.needsModel, false)
  assert.deepEqual(parsed.input.recruitment.prioritize, [{ name: '维什戴尔', skill: 3 }])
  assert.deepEqual(parsed.input.recruitment.promote, [{ name: '维什戴尔' }])
  assert.deepEqual(parsed.input.shopping.avoid, ['不灭的火炬'])
  assert.deepEqual(parsed.input.encounters, [{ name: '吉兆', choose: 1 }])
})

test('parses map tactics and kill-triggered actions without a model', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-fight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = await parseStrategyNote('让山堵门，30杀后撤退山', pendingFight(), {
    env: { ...process.env, DSH_MAA_CLI_STATE_DIR: root },
  })

  assert.equal(parsed.needsModel, false)
  assert.deepEqual(parsed.input.tactics, [{ kind: 'block_entrance', name: '山', kills: 0 }])
  assert.deepEqual(parsed.input.actions, [{ type: 'Retreat', name: '山', kills: 30 }])
})

test('fills an omitted tactic operator from enabled semantic memory', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const remembered = compileStrategyRequest({
    kind: 'Copilot', task: { stageName: 'T-1' }, tactics: [{ kind: 'block_entrance', name: '山', kills: 0 }],
  })
  await applyStrategyMemory(remembered, { resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })

  const parsed = await parseStrategyNote('堵门', pendingFight(), { env: env.env })
  assert.equal(parsed.needsModel, false)
  assert.deepEqual(parsed.input.tactics, [{ kind: 'block_entrance', name: '山', kills: 0 }])
})

test('routes only unresolved language to the model preparation flow', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-model-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = await parseStrategyNote('根据敌人血量随机应变', pendingFight(), {
    env: { ...process.env, DSH_MAA_CLI_STATE_DIR: root },
  })

  assert.equal(parsed.needsModel, true)
  assert.deepEqual(parsed.unresolved, ['根据敌人血量随机应变'])
  assert.match(noteModelPrompt(parsed), /纠正错别字/u)
  assert.match(noteModelPrompt(parsed), /maa_prepare_note/u)
})

test('parses roguelike autopilot tactics with stage, coordinates and facing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-rogue-tactic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = await parseStrategyNote('优先抓结城理，并在暗箭难防让结城理堵门 [3,1] 朝下', pendingRogue(), {
    env: { ...process.env, DSH_MAA_CLI_STATE_DIR: root },
  })

  assert.equal(parsed.needsModel, false)
  assert.deepEqual(parsed.input.recruitment.prioritize, [{ name: '结城理' }])
  assert.deepEqual(parsed.input.tactics, [{ kind: 'block_entrance', name: '结城理', stageName: '暗箭难防', location: [3, 1], direction: '下' }])
})

test('keeps a roguelike tactic without a stage explicit instead of dropping it', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-rogue-nostage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = await parseStrategyNote('优先招募结城理，并用他堵门', pendingRogue(), {
    env: { ...process.env, DSH_MAA_CLI_STATE_DIR: root },
  })

  assert.equal(parsed.needsModel, false)
  assert.deepEqual(parsed.input.tactics, [{ kind: 'block_entrance', name: '结城理' }])
  assert.equal(parsed.recognized.some(item => item.includes('堵门')), true)
})

test('parses a ticket-qualified note with a trailing placement word', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-rogue-ticket-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = await parseStrategyNote('有特种券优先抓结城理，结城理堵门放置', pendingRogue(), {
    env: { ...process.env, DSH_MAA_CLI_STATE_DIR: root },
  })

  assert.equal(parsed.needsModel, false)
  assert.deepEqual(parsed.input.recruitment.prioritize, [{ name: '结城理' }])
  assert.deepEqual(parsed.input.tactics, [{ kind: 'block_entrance', name: '结城理' }])
})

test('resolves 「用来堵门」 to the operator recruited earlier instead of 「来」', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-rogue-filler-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = await parseStrategyNote('有特种券则优先招募结城理，用来堵门', pendingRogue(), {
    env: { ...process.env, DSH_MAA_CLI_STATE_DIR: root },
  })

  assert.equal(parsed.needsModel, false)
  assert.deepEqual(parsed.input.recruitment.prioritize, [{ name: '结城理' }])
  assert.deepEqual(parsed.input.tactics, [{ kind: 'block_entrance', name: '结城理' }])
  assert.deepEqual(parsed.unresolved, [])
})

test('sends a filler-only tactic back to the model instead of inventing an operator', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-rogue-filler-only-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = await parseStrategyNote('用来堵门', pendingRogue(), {
    env: { ...process.env, DSH_MAA_CLI_STATE_DIR: root },
  })

  assert.equal(parsed.needsModel, true)
  assert.deepEqual(parsed.input.tactics ?? [], [])
})

test('carries the pending confirmation code into the model prompt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-note-model-code-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pending = { confirmationCode: 'MAA-ABCDEF', document: { tasks: [{ type: 'Roguelike', params: { theme: 'BlackFlow', mode: 0 } }] } }
  const parsed = await parseStrategyNote('根据敌人血量随机应变', pending, {
    env: { ...process.env, DSH_MAA_CLI_STATE_DIR: root },
  })

  assert.equal(parsed.needsModel, true)
  const prompt = noteModelPrompt(parsed)
  assert.match(prompt, /确认码：MAA-ABCDEF/u)
  assert.match(prompt, /confirmationCode/u)
  assert.match(prompt, /theme/u)
})
