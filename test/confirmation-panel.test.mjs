import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLocalMaaCommand } from '../src/commands/local-command.js'
import { applyRoguelikeOverrides, buildTaskDocument, resolveRoguelikeTheme, roguelikePanelFromDocument } from '../src/commands/planner.js'
import { decodeConfirmationNote } from '../src/index.js'
import { applyTaskPanelOverrides, taskPanelFromDocument } from '../src/commands/task-panel.js'

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

test('resolves english and chinese roguelike theme names', () => {
  assert.equal(resolveRoguelikeTheme('Sami'), 'Sami')
  assert.equal(resolveRoguelikeTheme('萨米'), 'Sami')
  assert.equal(resolveRoguelikeTheme('探索者的银凇止境'), 'Sami')
  assert.equal(resolveRoguelikeTheme('界园'), 'JieGarden')
  assert.equal(resolveRoguelikeTheme('黑流树海'), 'BlackFlow')
  assert.throws(() => resolveRoguelikeTheme('乌萨斯'), /无法识别肉鸽主题/)
  assert.throws(() => resolveRoguelikeTheme(''), /无法识别肉鸽主题/)
})

test('parses the zero-model rogue command', () => {
  assert.deepEqual(parseLocalMaaCommand('rogue 萨米 3'), {
    kind: 'plan',
    purpose: '肉鸽 Sami ×3',
    steps: [{ type: 'Roguelike', theme: 'Sami', startsCount: 3 }],
    roguelikeOverrides: {},
  })

  // No count means one run; the theme may also be the full chinese name.
  const one = parseLocalMaaCommand('肉鸽 黑流树海')
  assert.equal(one.steps[0].theme, 'BlackFlow')
  assert.equal(one.steps[0].startsCount, 1)

  // key=value tokens are pulled out for applyRoguelikeOverrides.
  const tuned = parseLocalMaaCommand('roguelike Sarkaz 2 mode=0 difficulty=4 useSupport=true')
  assert.equal(tuned.steps[0].theme, 'Sarkaz')
  assert.equal(tuned.steps[0].startsCount, 2)
  assert.deepEqual(tuned.roguelikeOverrides, { mode: '0', difficulty: '4', useSupport: 'true' })

  // A mode-only invocation keeps the default count.
  const modeOnly = parseLocalMaaCommand('rogue JieGarden mode=20001')
  assert.equal(modeOnly.steps[0].startsCount, 1)
  assert.deepEqual(modeOnly.roguelikeOverrides, { mode: '20001' })
})

test('rejects bad zero-model rogue commands', () => {
  assert.throws(() => parseLocalMaaCommand('rogue 乌萨斯 1'), /无法识别肉鸽主题/)
  assert.throws(() => parseLocalMaaCommand('rogue Sami 0'), /肉鸽次数必须是 1–99999/)
  assert.throws(() => parseLocalMaaCommand('rogue Sami 100000'), /肉鸽次数必须是 1–99999/)
  // 'rogue' without arguments is now valid (defaults to Phantom ×1)
  assert.throws(() => parseLocalMaaCommand('rogue Sami 2 theme'), /无法识别的确认参数/)
})

test('builds the zero-model rogue task exactly like the panel path', () => {
  const parsed = parseLocalMaaCommand('rogue 萨卡兹 3 difficulty=4 squad=蓝图测绘分队 roles=稳扎稳打 coreChar=维什戴尔 useSupport=false')
  const document = buildTaskDocument(parsed.steps)
  const outcome = applyRoguelikeOverrides(document, parsed.roguelikeOverrides)
  const params = outcome.document.tasks[0].params

  assert.equal(outcome.document.tasks[0].type, 'Roguelike')
  assert.equal(params.theme, 'Sarkaz')
  assert.equal(params.starts_count, 3)
  assert.equal(params.difficulty, 4)
  assert.equal(params.squad, '蓝图测绘分队')
  assert.equal(params.roles, '稳扎稳打')
  assert.equal(params.core_char, '维什戴尔')
  assert.equal(params.use_support, false)
  // The plugin-only summary never leaks into the MaaCore task JSON.
  assert.deepEqual(Object.keys(outcome.document), ['tasks'])
})

test('accepts the /maa rouge spelling and parses peek', () => {
  const rouge = parseLocalMaaCommand('rouge 萨米 2')
  assert.equal(rouge.kind, 'plan')
  assert.equal(rouge.steps[0].theme, 'Sami')
  assert.equal(rouge.steps[0].startsCount, 2)

  // No theme means default Phantom, no count means default 1
  const def = parseLocalMaaCommand('rouge')
  assert.equal(def.kind, 'plan')
  assert.equal(def.steps[0].theme, 'Phantom')
  assert.equal(def.steps[0].startsCount, 1)

  assert.deepEqual(parseLocalMaaCommand('peek MAA-1A2B3C'), { kind: 'peek', confirmationCode: 'MAA-1A2B3C' })
  assert.deepEqual(parseLocalMaaCommand('查看计划'), { kind: 'peek', confirmationCode: '' })
})

test('maps a pending document back to the confirmation panel', () => {
  const document = buildTaskDocument([{ type: 'Roguelike', theme: 'Sarkaz', startsCount: 3, difficulty: 4, squad: '蓝图测绘分队' }])
  const patched = applyRoguelikeOverrides(document, { useSupport: 'true', startWithEliteTwo: 'true' }).document
  const panel = roguelikePanelFromDocument(patched)

  assert.equal(panel.theme, 'Sarkaz')
  assert.equal(panel.startsCount, 3)
  assert.equal(panel.difficulty, 4)
  assert.equal(panel.squad, '蓝图测绘分队')
  assert.equal(panel.useSupport, true)
  assert.equal(panel.startWithEliteTwo, true)
  // Panel keys are camelCase; no MaaCore snake_case key leaks out.
  assert.equal(panel.starts_count, undefined)

  assert.equal(roguelikePanelFromDocument(buildTaskDocument([{ type: 'StartUp' }])), null)
})

test('opens every MAA task from a project-only zero-model command', () => {
  const cases = [
    ['startup', ['StartUp'], 'StartUp'],
    ['fight', ['Fight'], 'Fight'],
    ['flight', ['Fight'], 'Fight'],
    ['infrast', ['Infrast'], 'Infrast'],
    ['recruit', ['Recruit'], 'Recruit'],
    ['mall', ['Mall'], 'Mall'],
    ['award', ['Award'], 'Award'],
    ['rouge', ['Roguelike'], 'Roguelike'],
    ['reclamation', ['ReclamationAlgorithm'], 'ReclamationAlgorithm'],
    ['update', ['OperBox', 'Depot'], 'UserDataUpdate'],
  ]
  for (const [command, types, panelType] of cases) {
    const parsed = parseLocalMaaCommand(command)
    assert.equal(parsed.kind, 'plan', command)
    assert.deepEqual(parsed.steps.map(step => step.type), types, command)
    const panel = taskPanelFromDocument(buildTaskDocument(parsed.steps))
    assert.equal(panel.type, panelType, command)
    assert.equal(typeof panel.title, 'string')
    assert.equal(typeof panel.values, 'object')
  }
})

test('applies MAA panel values to each core task with typed validation', () => {
  const startup = applyTaskPanelOverrides(buildTaskDocument(parseLocalMaaCommand('startup').steps), {
    clientType: 'Bilibili', startGameEnabled: 'true', accountName: 'doctor%20123',
  }).document.tasks[0].params
  assert.equal(startup.client_type, 'Bilibili')
  assert.equal(startup.account_name, 'doctor 123')

  const fight = applyTaskPanelOverrides(buildTaskDocument(parseLocalMaaCommand('fight').steps), {
    stage: '1-7', times: '10', series: '10', medicine: '0', medicineExpireDays: '2', stone: '0', drGrandet: 'false',
  }).document.tasks[0].params
  assert.equal(fight.stage, '1-7')
  assert.equal(fight.times, 10)
  assert.equal(fight.series, 10)
  assert.equal(fight.medicine_expire_days, 2)

  const infrast = applyTaskPanelOverrides(buildTaskDocument(parseLocalMaaCommand('infrast').steps), {
    mode: '0', facilities: 'Mfg,Trade,Recycle', drones: 'PureGold', threshold: '0.3', replenish: 'true',
  }).document.tasks[0].params
  assert.deepEqual(infrast.facility, ['Mfg', 'Trade', 'Recycle'])
  assert.equal(infrast.drones, 'PureGold')

  const recruit = applyTaskPanelOverrides(buildTaskDocument(parseLocalMaaCommand('recruit').steps), {
    refresh: 'true', select: '4,5,6', confirm: '3,4', times: '4', setTime: 'true', expedite: 'false', preserveTags: '%E6%94%AF%E6%8F%B4%E6%9C%BA%E6%A2%B0',
  }).document.tasks[0].params
  assert.deepEqual(recruit.confirm, [3, 4])
  assert.deepEqual(recruit.preserve_tags, ['支援机械'])

  const mall = applyTaskPanelOverrides(buildTaskDocument(parseLocalMaaCommand('mall').steps), {
    visitFriends: 'true', shopping: 'true', buyFirst: '%E6%8B%9B%E8%81%98%E8%AE%B8%E5%8F%AF%3B%E9%BE%99%E9%97%A8%E5%B8%81', blacklist: '', creditFight: 'false',
  }).document.tasks[0].params
  assert.deepEqual(mall.buy_first, ['招聘许可', '龙门币'])
  assert.deepEqual(mall.blacklist, [])

  const award = applyTaskPanelOverrides(buildTaskDocument(parseLocalMaaCommand('award').steps), {
    dailyWeekly: 'true', mail: 'true', freePull: 'false', orundum: 'false', mining: 'true', specialAccess: 'false', signInEvent: 'false',
  }).document.tasks[0].params
  assert.equal(award.mail, true)
  assert.equal(award.mining, true)

  const reclamation = applyTaskPanelOverrides(buildTaskDocument(parseLocalMaaCommand('reclamation').steps), {
    theme: 'Tales', mode: '1', toolToCraft: '%E8%8D%A7%E5%85%89%E6%A3%92%3B%E5%8F%91%E7%94%B5%E6%9C%BA', numCraftBatches: '12', incrementMode: '0',
  }).document.tasks[0].params
  assert.deepEqual(reclamation.tools_to_craft, ['荧光棒', '发电机'])
  assert.equal(reclamation.num_craft_batches, 12)
})

test('updates Box and depot selections without inventing a MaaCore task type', () => {
  const document = buildTaskDocument(parseLocalMaaCommand('update').steps)
  const panel = taskPanelFromDocument(document)
  assert.deepEqual(panel.values, { updateOperBox: true, updateDepot: true })
  const onlyBox = applyTaskPanelOverrides(document, { updateOperBox: 'true', updateDepot: 'false' })
  assert.deepEqual(onlyBox.document.tasks.map(task => task.type), ['OperBox'])
  assert.throws(
    () => applyTaskPanelOverrides(document, { updateOperBox: 'false', updateDepot: 'false' }),
    /至少选择干员 Box 或仓库/,
  )
})

test('carries MAA remarks and mode-specific reclamation instructions into panels', () => {
  const reclamation = taskPanelFromDocument(buildTaskDocument(parseLocalMaaCommand('reclamation').steps))
  assert.equal(reclamation.notes.length, 5)
  assert.match(reclamation.notes.find(note => note.when.equals === 0).text, /误删存档/)
  assert.match(reclamation.notes.find(note => note.when.equals === 1).text, /荧光棒/)
  assert.match(reclamation.notes.find(note => note.when.equals === 16).text, /RA-1 自动循环/)
  assert.match(reclamation.notes.find(note => note.when.equals === 32).text, /圣聆初雪/)
  assert.match(reclamation.notes.find(note => note.when.equals === 48).text, /维什戴尔/)

  const fight = taskPanelFromDocument(buildTaskDocument(parseLocalMaaCommand('fight').steps))
  assert.match(fight.fields.find(field => field.key === 'series').description, /自动最大倍率/)
  assert.match(fight.fields.find(field => field.key === 'drGrandet').description, /1 点理智/)

  const infrast = taskPanelFromDocument(buildTaskDocument(parseLocalMaaCommand('infrast').steps))
  assert.match(infrast.notes.find(note => note.when.equals === 20000).text, /整队替换/)
  assert.match(infrast.fields.find(field => field.key === 'receptionClueExchange').description, /10 张/)

  const recruit = taskPanelFromDocument(buildTaskDocument(parseLocalMaaCommand('recruit').steps))
  assert.match(recruit.fields.find(field => field.key === 'expedite').description, /应急场景/)
  const mall = taskPanelFromDocument(buildTaskDocument(parseLocalMaaCommand('mall').steps))
  assert.match(mall.fields.find(field => field.key === 'onlyBuyDiscount').description, /信用点溢出/)
  const award = taskPanelFromDocument(buildTaskDocument(parseLocalMaaCommand('award').steps))
  assert.match(award.fields.find(field => field.key === 'freePull').description, /误抽风险/)
})

test('rejects invalid cross-field MAA panel combinations', () => {
  const infrast = buildTaskDocument(parseLocalMaaCommand('infrast').steps)
  assert.throws(() => applyTaskPanelOverrides(infrast, { mode: '10000', filename: '' }), /必须选择排班文件/)
  const reclamation = buildTaskDocument(parseLocalMaaCommand('reclamation').steps)
  assert.throws(() => applyTaskPanelOverrides(reclamation, { theme: 'RelaunchAnchor', mode: '1' }), /不支持所选模式/)
  const fight = buildTaskDocument(parseLocalMaaCommand('fight').steps)
  assert.throws(() => applyTaskPanelOverrides(fight, { stone: '21' }), /必须在 0–20 范围内/)
  assert.throws(() => applyTaskPanelOverrides(fight, { shell: 'whoami' }), /不支持参数/)
})
