import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLocalMaaCommand } from './local-command.js'
import { applyRoguelikeOverrides, buildTaskDocument } from './planner.js'

function documentOf(steps) {
  return buildTaskDocument(steps)
}

test('parses a plain confirmation without overrides', () => {
  assert.deepEqual(parseLocalMaaCommand('confirm MAA-1A2B3C'), {
    kind: 'confirm', confirmationCode: 'MAA-1A2B3C', overrides: {},
  })
})

test('parses roguelike parameters carried by the confirmation panel', () => {
  const parsed = parseLocalMaaCommand('confirm MAA-1A2B3C theme=Sarkaz startsCount=3 difficulty=12 useSupport=true stopAtFinalBoss=false')
  assert.equal(parsed.kind, 'confirm')
  assert.equal(parsed.confirmationCode, 'MAA-1A2B3C')
  assert.deepEqual(parsed.overrides, {
    theme: 'Sarkaz', startsCount: '3', difficulty: '12', useSupport: 'true', stopAtFinalBoss: 'false',
  })
})

test('rejects a malformed confirmation parameter token', () => {
  assert.throws(() => parseLocalMaaCommand('confirm MAA-1A2B3C theme'), /无法识别的确认参数/)
  assert.throws(() => parseLocalMaaCommand('confirm MAA-1A2B3C =Sarkaz'), /无法识别的确认参数/)
})

test('applies roguelike overrides to the pending document only', () => {
  const original = documentOf([
    { type: 'StartUp', clientType: 'Official' },
    { type: 'Roguelike', theme: 'Phantom', startsCount: 1 },
  ])
  const outcome = applyRoguelikeOverrides(original, {
    theme: 'Sarkaz', startsCount: '4', difficulty: '0', squad: '默认分队',
    coreChar: '斯卡蒂', useSupport: 'true', stopAtFinalBoss: 'true',
  })
  const patched = outcome.document

  assert.equal(original.tasks[1].params.theme, 'Phantom')
  assert.equal(original.tasks[1].params.starts_count, 1)

  const params = patched.tasks[1].params
  assert.equal(params.theme, 'Sarkaz')
  assert.equal(params.starts_count, 4)
  assert.equal(params.difficulty, 0)
  assert.equal(params.squad, '默认分队')
  assert.equal(params.core_char, '斯卡蒂')
  assert.equal(params.use_support, true)
  assert.equal(params.stop_at_final_boss, true)
  assert.deepEqual(outcome.applied, [
    '主题=Sarkaz', '刷取次数=4', '难度=0', '分队=默认分队', '起始干员=斯卡蒂',
    '使用助战=true', '打到最终 Boss 停=true',
  ])
  // The task JSON handed to MaaCore must not gain plugin-only keys.
  assert.deepEqual(Object.keys(patched), Object.keys(original))
  // Non-roguelike steps stay untouched.
  assert.deepEqual(patched.tasks[0], original.tasks[0])
})

test('rejects unknown keys, bad values, and non-roguelike plans', () => {
  const roguelike = documentOf([{ type: 'Roguelike', theme: 'Phantom', startsCount: 1 }])
  assert.throws(() => applyRoguelikeOverrides(roguelike, { theme: 'Nope' }), /肉鸽主题无效/)
  assert.throws(() => applyRoguelikeOverrides(roguelike, { startsCount: '0' }), /必须在 1–20 之间/)
  assert.throws(() => applyRoguelikeOverrides(roguelike, { startsCount: '2.5' }), /必须是整数/)
  assert.throws(() => applyRoguelikeOverrides(roguelike, { useSupport: 'yes' }), /只能是 true 或 false/)
  assert.throws(() => applyRoguelikeOverrides(roguelike, { medicine: '1' }), /无法识别肉鸽参数/)

  const fight = documentOf([{ type: 'Fight', stage: '1-7', times: 1 }])
  assert.throws(() => applyRoguelikeOverrides(fight, { startsCount: '2' }), /没有肉鸽任务/)
})

test('leaves the document alone when no overrides are supplied', () => {
  const document = documentOf([{ type: 'Roguelike', theme: 'Phantom', startsCount: 1 }])
  const outcome = applyRoguelikeOverrides(document, {})
  assert.equal(outcome.document, document)
  assert.deepEqual(outcome.applied, [])
})
