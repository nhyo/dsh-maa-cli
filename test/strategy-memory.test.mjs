import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { compileStrategyRequest } from '../src/strategy/compiler.js'
import {
  applyStrategyMemory,
  parseMaaCompatibility,
  readStrategyMemory,
  rememberPlanStrategies,
  STRATEGY_MEMORY_LIMIT,
} from '../src/strategy/memory.js'

const COMPATIBILITY = { cliVersion: '0.7.7', coreVersion: '6.20.1' }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-memory-'))
  const resource = path.join(root, 'resource')
  const theme = path.join(resource, 'roguelike', 'Sami')
  const maps = path.join(resource, 'Arknights-Tile-Pos')
  await mkdir(path.join(theme, 'encounter'), { recursive: true })
  await mkdir(maps, { recursive: true })
  await writeFile(path.join(theme, 'recruitment.json'), JSON.stringify({
    priority: [{ name: '高台C', opers: [{ name: '维什戴尔', recruit_priority: 100, promote_priority: 100 }] }],
    team_complete_condition: [{ groups: ['高台C'], threshold: 1 }],
  }))
  await writeFile(path.join(theme, 'shopping.json'), JSON.stringify({
    priority: [{ name: '锈蚀的铁锤' }, { name: '不灭的火炬' }], other: [],
  }))
  await writeFile(path.join(theme, 'encounter', 'default.json'), JSON.stringify({
    stage: [{ name: '吉兆', option_num: 2, choose: 1 }],
  }))
  await writeFile(path.join(resource, 'stages.json'), JSON.stringify([
    { code: 'T-1', stageId: 'test_1' }, { code: 'T-2', stageId: 'test_2' },
  ]))
  for (const [code, id] of [['T-1', 'test_1'], ['T-2', 'test_2']]) {
    await writeFile(path.join(maps, `${id}-map.json`), JSON.stringify({
      code, stageId: id,
      tiles: [[
        { buildableType: 0, isStart: true },
        { buildableType: 1 }, { buildableType: 1 },
        { buildableType: 0, isEnd: true },
      ]],
    }))
  }
  const env = { ...process.env, DSH_MAA_CLI_STATE_DIR: path.join(root, 'state') }
  return { root, resource, env, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('parses the maa-cli and MaaCore compatibility tuple', () => {
  assert.deepEqual(parseMaaCompatibility('maa-cli v0.7.7\nMaaCore v6.20.1'), COMPATIBILITY)
  assert.throws(() => parseMaaCompatibility('maa-cli v0.7.7'), /MaaCore/u)
})

test('persists semantic plan units by category and keeps the latest twenty', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  for (let index = 0; index < 25; index += 1) {
    await rememberPlanStrategies([{ type: 'Fight', stage: `S-${index}`, times: 1 }], COMPATIBILITY, { env: env.env })
  }
  const reclamationFirst = await rememberPlanStrategies([{ type: 'ReclamationAlgorithm', mode: 0 }], COMPATIBILITY, { env: env.env })
  const reclamationSecond = await rememberPlanStrategies([{ type: 'ReclamationAlgorithm', mode: 16 }], COMPATIBILITY, { env: env.env })
  await rememberPlanStrategies([{ type: 'Infrast', mode: 0 }], COMPATIBILITY, { env: env.env })
  const custom = await rememberPlanStrategies([{ type: 'Custom', taskNames: ['local-only'] }], COMPATIBILITY, { env: env.env })

  const stored = await readStrategyMemory({ env: env.env })
  assert.equal(stored.categories.combat.length, STRATEGY_MEMORY_LIMIT)
  assert.equal(stored.categories.combat.some(item => item.semanticKey === 'task:Fight:S-0'), false)
  assert.equal(stored.categories.combat.at(-1).semanticKey, 'task:Fight:S-24')
  assert.equal(reclamationFirst.stored, 1)
  assert.equal(reclamationSecond.reused, 1)
  assert.equal(stored.categories.reclamation.length, 1)
  assert.equal(stored.categories.reclamation[0].atom.step.mode, 16)
  assert.equal(stored.categories.infrast.length, 1)
  assert.equal(custom.rejected, 1)
  assert.equal(stored.categories.custom, undefined)
})

test('reuses one tactical strategy across maps while regenerating map applicability', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const first = compileStrategyRequest({
    kind: 'Copilot', task: { stageName: 'T-1' }, tactics: [{ kind: 'block_entrance', name: '山', kills: 0 }],
  })
  const second = compileStrategyRequest({
    kind: 'Copilot', task: { stageName: 'T-2' }, tactics: [{ kind: 'block_entrance', name: '塞雷娅', kills: 12 }],
  })
  const firstResult = await applyStrategyMemory(first, { resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  const secondResult = await applyStrategyMemory(second, { resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  const stored = await readStrategyMemory({ env: env.env })

  assert.equal(firstResult.memory.stored, 1)
  assert.equal(secondResult.memory.reused, 1)
  assert.equal(stored.categories.combat.length, 1)
  assert.equal(stored.categories.combat[0].semanticKey, 'tactic:block_entrance')
  assert.equal(stored.categories.combat[0].atom.payload.name, '塞雷娅')
  assert.equal(stored.categories.combat[0].atom.applicability.stageName, 'T-2')
})

test('stores only valid atomic units, updates parameters, and rejects conflicts', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const mixed = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami' },
    recruitment: { prioritize: [{ name: '维什戴尔', priority: 1000 }] },
    shopping: { prioritize: ['不存在的藏品'] },
    unsupportedRequirements: [{ request: '实时看怪改策略', reason: 'MAA 没有对应协议字段' }],
  })
  const first = await applyStrategyMemory(mixed, { resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  let stored = await readStrategyMemory({ env: env.env })
  assert.equal(first.memory.stored, 2)
  assert.equal(first.memory.rejected, 1)
  assert.equal(Object.values(stored.categories).flat().some(item => JSON.stringify(item).includes('不存在的藏品')), false)
  assert.equal(Object.values(stored.categories).flat().some(item => JSON.stringify(item).includes('实时看怪改策略')), false)

  const changed = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami' },
    recruitment: { prioritize: [{ name: '维什戴尔', priority: 4321 }] },
  })
  const second = await applyStrategyMemory(changed, { resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  stored = await readStrategyMemory({ env: env.env })
  assert.equal(second.memory.reused, 2)
  assert.equal(stored.categories.roguelike.find(item => item.semanticKey.includes('维什戴尔')).atom.payload.priority, 4321)

  const conflict = compileStrategyRequest({
    kind: 'Roguelike', task: { theme: 'Sami' },
    shopping: { prioritize: ['锈蚀的铁锤'], avoid: ['锈蚀的铁锤'] },
  })
  const conflictResult = await applyStrategyMemory(conflict, { resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  stored = await readStrategyMemory({ env: env.env })
  assert.equal(conflictResult.memory.rejected, 2)
  assert.equal(conflictResult.strategy.shopping.prioritize.length, 0)
  assert.equal(conflictResult.strategy.shopping.avoid.length, 0)
  assert.equal(stored.categories.roguelike.some(item => item.semanticKey.includes('锈蚀的铁锤')), false)
})

test('does not reuse an entry across an incompatible maa-cli line', async t => {
  const env = await fixture()
  t.after(env.cleanup)
  const strategy = compileStrategyRequest({
    kind: 'Copilot', task: { stageName: 'T-1' }, tactics: [{ kind: 'guard_blue', name: '塞雷娅' }],
  })
  await applyStrategyMemory(strategy, { resourceDir: env.resource, compatibility: COMPATIBILITY, env: env.env })
  const changed = await applyStrategyMemory(strategy, {
    resourceDir: env.resource,
    compatibility: { cliVersion: '0.8.0', coreVersion: '6.20.1' },
    env: env.env,
  })
  assert.equal(changed.memory.reused, 0)
  assert.equal(changed.memory.stored, 1)
})
