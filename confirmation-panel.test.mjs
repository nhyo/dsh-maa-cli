import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLocalMaaCommand } from './local-command.js'
import { applyRoguelikeOverrides, buildTaskDocument } from './planner.js'
import { decodeConfirmationNote } from './index.js'

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
  assert.throws(() => applyRoguelikeOverrides(roguelike, { startsCount: '0' }), /必须在 1–99999 之间/)
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

test('maps the MAA advanced roguelike switches and modes', () => {
  const document = documentOf([{ type: 'Roguelike', theme: 'Sarkaz', startsCount: 1 }])
  const outcome = applyRoguelikeOverrides(document, {
    mode: '10001',
    stopAtMaxLevel: 'true',
    investmentEnabled: 'false',
    investmentsCount: '0',
    stopWhenInvestmentFull: 'true',
    investmentWithMoreScore: 'false',
    startWithEliteTwo: 'true',
    onlyStartWithEliteTwo: 'false',
    monthlySquadAutoIterate: 'true',
    deepExplorationAutoIterate: 'true',
    findPlayTimeTarget: '2',
    useNonFriendSupport: 'true',
  })
  const params = outcome.document.tasks[0].params
  assert.equal(params.mode, 10001)
  assert.equal(params.stop_at_max_level, true)
  assert.equal(params.investment_enabled, false)
  assert.equal(params.investments_count, 0)
  assert.equal(params.stop_when_investment_full, true)
  assert.equal(params.investment_with_more_score, false)
  assert.equal(params.start_with_elite_two, true)
  assert.equal(params.only_start_with_elite_two, false)
  assert.equal(params.monthly_squad_auto_iterate, true)
  assert.equal(params.deep_exploration_auto_iterate, true)
  assert.equal(params.find_playTime_target, 2)
  assert.equal(params.use_nonfriend_support, true)
  assert.equal(outcome.applied.length, 12)
})

test('rejects roguelike modes MaaCore no longer accepts', () => {
  const document = documentOf([{ type: 'Roguelike', theme: 'Sarkaz', startsCount: 1 }])
  // 2 was removed and 3 was never opened; 9 is not a mode at all.
  assert.throws(() => applyRoguelikeOverrides(document, { mode: '2' }), /肉鸽模式无效/)
  assert.throws(() => applyRoguelikeOverrides(document, { mode: '3' }), /肉鸽模式无效/)
  assert.throws(() => applyRoguelikeOverrides(document, { mode: '9' }), /肉鸽模式无效/)
  assert.throws(() => applyRoguelikeOverrides(document, { mode: 'fast' }), /肉鸽模式无效/)
  assert.throws(() => applyRoguelikeOverrides(document, { findPlayTimeTarget: '4' }), /必须在 1–3 之间/)
})

test('accepts the newest theme 黑流树海 with its own mode', () => {
  const document = documentOf([{ type: 'Roguelike', theme: 'Phantom', startsCount: 1 }])
  const outcome = applyRoguelikeOverrides(document, {
    theme: 'BlackFlow',
    mode: '30001',
    difficulty: '0',
    squad: '特勤分队',
    roles: '坚不可摧',
    coreChar: '机械师',
  })
  const params = outcome.document.tasks[0].params
  assert.equal(params.theme, 'BlackFlow')
  assert.equal(params.mode, 30001)
  assert.equal(params.difficulty, 0)
  assert.equal(params.squad, '特勤分队')
  assert.equal(params.roles, '坚不可摧')
  assert.equal(params.core_char, '机械师')
})

test('keeps BlackFlow in the theme list and after 界园', () => {
  assert.throws(() => applyRoguelikeOverrides(
    documentOf([{ type: 'Roguelike', theme: 'Phantom', startsCount: 1 }]),
    { theme: 'Nope' },
  ), /Phantom \/ Mizuki \/ Sami \/ Sarkaz \/ JieGarden \/ BlackFlow/)
  assert.equal(buildTaskDocument([{ type: 'Roguelike', theme: 'BlackFlow', startsCount: 1 }])
    .tasks[0].params.theme, 'BlackFlow')
})

test('defaults 刷取次数 to 9999 and accepts hand-typed counts', () => {
  const document = documentOf([{ type: 'Roguelike', theme: 'Phantom', startsCount: 9999 }])
  assert.equal(document.tasks[0].params.starts_count, 9999)
  const patched = applyRoguelikeOverrides(document, { startsCount: '9999' })
  assert.equal(patched.document.tasks[0].params.starts_count, 9999)
  assert.deepEqual(patched.applied, ['刷取次数=9999'])
  assert.throws(() => applyRoguelikeOverrides(document, { startsCount: '100000' }), /必须在 1–99999 之间/)
})

test('maps the theme-only advanced switches', () => {
  const sami = documentOf([{ type: 'Roguelike', theme: 'Sami', startsCount: 1 }])
  const samiOutcome = applyRoguelikeOverrides(sami, {
    useFoldartal: 'false', checkCollapsalParadigms: 'true',
  })
  assert.equal(samiOutcome.document.tasks[0].params.use_foldartal, false)
  assert.equal(samiOutcome.document.tasks[0].params.check_collapsal_paradigms, true)
  assert.deepEqual(samiOutcome.applied, ['使用密文板=false', '检测坍缩范式=true'])

  const mizuki = documentOf([{ type: 'Roguelike', theme: 'Mizuki', startsCount: 1 }])
  const mizukiOutcome = applyRoguelikeOverrides(mizuki, { refreshTraderWithDice: 'true' })
  assert.equal(mizukiOutcome.document.tasks[0].params.refresh_trader_with_dice, true)
})

test('carries a URL-encoded 备注 through the confirm command', () => {
  const parsed = parseLocalMaaCommand('confirm MAA-1A2B3C theme=Sami note=%E6%89%93%E5%AE%8C%E5%B0%B1%E5%81%9C')
  assert.equal(parsed.overrides.note, '%E6%89%93%E5%AE%8C%E5%B0%B1%E5%81%9C')
  // A plan without overrides still accepts just a note.
  assert.deepEqual(parseLocalMaaCommand('confirm MAA-1A2B3C note=hi').overrides, { note: 'hi' })
})

test('decodes the 备注 for DSH and rejects unusable values', () => {
  assert.equal(decodeConfirmationNote('%E6%89%93%E5%AE%8C%E5%B0%B1%E5%81%9C'), '打完就停')
  assert.equal(decodeConfirmationNote(''), '')
  assert.equal(decodeConfirmationNote('a%0Ab'), 'a b')
  assert.throws(() => decodeConfirmationNote('%E6%89'), /URL 编码不合法/)
  assert.throws(() => decodeConfirmationNote('x'.repeat(121)), /最多 120 个字符/)
})
