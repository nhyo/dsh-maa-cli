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
  assert.match(noteModelPrompt(parsed), /只处理本地规则无法确定的部分/u)
  assert.match(noteModelPrompt(parsed), /maa_prepare_strategy/u)
})
