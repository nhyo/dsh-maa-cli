import { applyRoguelikeOverrides, roguelikePanelFromDocument } from './planner.js'

const CLIENT_OPTIONS = [
  ['Official', '官服'], ['Bilibili', 'B 服'], ['Txwy', '繁中服'],
  ['YoStarEN', '国际服'], ['YoStarJP', '日服'], ['YoStarKR', '韩服'],
]
const FACILITY_OPTIONS = [
  ['Mfg', '制造站'], ['Trade', '贸易站'], ['Power', '发电站'], ['Control', '控制中枢'],
  ['Reception', '会客室'], ['Office', '办公室'], ['Recycle', '回收站'], ['Dorm', '宿舍'],
  ['Processing', '加工站'], ['Training', '训练室'], ['AssistantChange', '副手换人'],
]
const DRONE_OPTIONS = [
  ['_NotUse', '不使用'], ['Money', '贸易站－龙门币'], ['SyntheticJade', '贸易站－合成玉'],
  ['CombatRecord', '制造站－作战记录'], ['PureGold', '制造站－赤金'],
  ['OriginStone', '制造站－源石碎片'], ['Chip', '制造站－芯片'],
]
const STAR_OPTIONS = [1, 2, 3, 4, 5, 6].map(value => [value, `${value} 星`])

function option(value, label) { return { value, label } }
function options(entries) { return entries.map(([value, label]) => option(value, label)) }
function field(key, label, kind, param, extra = {}) { return { key, label, kind, param, ...extra } }

const PANELS = {
  StartUp: {
    title: '开始唤醒',
    fields: [
      field('clientType', '客户端', 'select', 'client_type', { options: options(CLIENT_OPTIONS), default: 'Official' }),
      field('startGameEnabled', '自动启动游戏', 'boolean', 'start_game_enabled', { default: true }),
      field('accountName', '切换账号（可留空）', 'text', 'account_name', { default: '', maxLength: 64 }),
    ],
  },
  Fight: {
    title: '理智作战',
    fields: [
      field('stage', '关卡', 'text', 'stage', { default: '', maxLength: 32, placeholder: '留空＝当前/上次关卡' }),
      field('times', '作战次数', 'integer', 'times', { default: 1, min: 1, max: 100 }),
      field('series', '代理倍率', 'select', 'series', { default: 1, options: options([[-1, '不自动切换'], [0, '自动最大倍率'], [1, '1 倍'], [2, '2 倍'], [3, '3 倍'], [4, '4 倍'], [5, '5 倍'], [6, '6 倍'], [7, '7 倍'], [8, '8 倍'], [9, '9 倍'], [10, '10 倍']]) }),
      field('medicine', '理智药上限', 'integer', 'medicine', { default: 0, min: 0, max: 99 }),
      field('medicineExpireDays', '使用几天内过期理智药', 'integer', 'medicine_expire_days', { default: 0, min: 0, max: 99 }),
      field('stone', '源石上限', 'integer', 'stone', { default: 0, min: 0, max: 20 }),
      field('drGrandet', '博朗台模式', 'boolean', 'DrGrandet', { default: false, advanced: true }),
    ],
  },
  Infrast: {
    title: '基建换班',
    fields: [
      field('mode', '换班模式', 'select', 'mode', { default: 0, options: options([[0, '常规模式'], [10000, '自定义排班'], [20000, '队列轮换']]) }),
      field('facilities', '处理设施', 'multi', 'facility', { default: FACILITY_OPTIONS.map(item => item[0]), options: options(FACILITY_OPTIONS) }),
      field('drones', '无人机用途', 'select', 'drones', { default: '_NotUse', options: options(DRONE_OPTIONS), when: { key: 'mode', notEquals: 10000 } }),
      field('threshold', '工作心情阈值', 'number', 'threshold', { default: 0.3, min: 0, max: 1, step: 0.05, when: { key: 'mode', notEquals: 20000 } }),
      field('replenish', '源石碎片自动补货', 'boolean', 'replenish', { default: false }),
      field('dormNotStationed', '宿舍不放入已进驻干员', 'boolean', 'dorm_notstationed_enabled', { default: false, advanced: true }),
      field('dormTrust', '宿舍信赖补位', 'boolean', 'dorm_trust_enabled', { default: false, advanced: true }),
      field('receptionMessageBoard', '领取会客室信息板信用', 'boolean', 'reception_message_board', { default: true, advanced: true }),
      field('receptionClueExchange', '进行线索交流', 'boolean', 'reception_clue_exchange', { default: true, advanced: true }),
      field('receptionSendClue', '赠送线索', 'boolean', 'reception_send_clue', { default: true, advanced: true }),
      field('continueTraining', '继续未完成专精训练', 'boolean', 'continue_training', { default: false, advanced: true }),
      field('filename', '自定义排班文件', 'text', 'filename', { default: '', maxLength: 260, when: { key: 'mode', equals: 10000 } }),
      field('planIndex', '排班方案序号', 'integer', 'plan_index', { default: 0, min: 0, max: 999, when: { key: 'mode', equals: 10000 } }),
    ],
  },
  Recruit: {
    title: '自动公招',
    fields: [
      field('refresh', '刷新三星 Tags', 'boolean', 'refresh', { default: false }),
      field('select', '自动选择的 Tag 星级', 'multi', 'select', { default: [4, 5, 6], options: options(STAR_OPTIONS) }),
      field('confirm', '自动确认的 Tag 星级', 'multi', 'confirm', { default: [], options: options(STAR_OPTIONS) }),
      field('times', '招募次数（0＝仅计算）', 'integer', 'times', { default: 0, min: 0, max: 4 }),
      field('setTime', '自动设置招募时限', 'boolean', 'set_time', { default: true }),
      field('expedite', '使用加急许可', 'boolean', 'expedite', { default: false }),
      field('permitReserve', '三星保留招聘许可数', 'integer', 'level3_recruitment_permit_reserve', { default: 0, min: 0, max: 999, advanced: true }),
      field('firstTags', '三星首选 Tags', 'list', 'first_tags', { default: '', maxItems: 10, maxLength: 24, advanced: true, placeholder: '用分号分隔' }),
      field('preserveTags', '保留并跳过的 Tags', 'list', 'preserve_tags', { default: '支援机械', maxItems: 10, maxLength: 24, advanced: true, placeholder: '用分号分隔' }),
      field('extraTagsMode', '额外选择 Tags', 'select', 'extra_tags_mode', { default: 0, advanced: true, options: options([[0, '默认'], [1, '选满 3 个'], [2, '尽量选择更多高星组合']]) }),
    ],
  },
  Mall: {
    title: '信用收支',
    fields: [
      field('visitFriends', '访问好友获取信用', 'boolean', 'visit_friends', { default: true }),
      field('shopping', '信用商店购物', 'boolean', 'shopping', { default: true }),
      field('buyFirst', '优先购买', 'list', 'buy_first', { default: '招聘许可', maxItems: 20, maxLength: 32, placeholder: '用分号分隔' }),
      field('blacklist', '购物黑名单', 'list', 'blacklist', { default: '碳;家具;加急许可', maxItems: 20, maxLength: 32, placeholder: '用分号分隔' }),
      field('forceShoppingIfCreditFull', '信用溢出时忽略黑名单', 'boolean', 'force_shopping_if_credit_full', { default: false, advanced: true }),
      field('onlyBuyDiscount', '仅购买折扣商品', 'boolean', 'only_buy_discount', { default: false, advanced: true }),
      field('reserveMaxCredit', '信用低于 300 时停止购买', 'boolean', 'reserve_max_credit', { default: false, advanced: true }),
      field('creditFight', '借助战通关 OF-1', 'boolean', 'credit_fight', { default: false, advanced: true }),
      field('formationIndex', '助战关卡编队', 'select', 'formation_index', { default: 0, advanced: true, when: { key: 'creditFight', equals: true }, options: options([[0, '当前编队'], [1, '第一编队'], [2, '第二编队'], [3, '第三编队'], [4, '第四编队']]) }),
    ],
  },
  Award: {
    title: '领取奖励',
    fields: [
      field('dailyWeekly', '每日/每周任务奖励', 'boolean', 'award', { default: true }),
      field('mail', '领取邮件奖励', 'boolean', 'mail', { default: false }),
      field('freePull', '限时寻访免费单抽', 'boolean', 'recruit', { default: false }),
      field('orundum', '幸运墙合成玉', 'boolean', 'orundum', { default: false }),
      field('mining', '限时开采许可', 'boolean', 'mining', { default: false }),
      field('specialAccess', '特殊月卡奖励', 'boolean', 'specialaccess', { default: false }),
      field('signInEvent', '限时签到活动', 'boolean', 'signinevent', { default: false }),
    ],
  },
  ReclamationAlgorithm: {
    title: '生息演算',
    fields: [
      field('theme', '主题', 'select', 'theme', { default: 'Tales', options: options([['Tales', '沙洲遗闻'], ['RelaunchAnchor', '重启锚点']]) }),
      field('mode', '模式', 'select', 'mode', { default: 0, options: options([[0, '无存档刷生息点'], [1, '有存档制造道具'], [16, 'RA-1 自动循环'], [32, 'RA-15 60 杀'], [48, 'RA-4 解锁与击杀']]) }),
      field('toolToCraft', '制造物品', 'list', 'tools_to_craft', { default: '', maxItems: 10, maxLength: 32, when: { key: 'mode', equals: 1 }, placeholder: '用分号分隔' }),
      field('numCraftBatches', '单次制造轮数', 'integer', 'num_craft_batches', { default: 16, min: 1, max: 16, when: { key: 'theme', equals: 'Tales' } }),
      field('incrementMode', '点击类型', 'select', 'increment_mode', { default: 0, when: { key: 'theme', equals: 'Tales' }, options: options([[0, '连点'], [1, '长按']]) }),
      field('clearStore', '完成后清空商店', 'boolean', 'clear_store', { default: false, when: { key: 'mode', equals: 0 } }),
    ],
  },
  UserDataUpdate: {
    title: '更新数据',
    fields: [
      field('updateOperBox', '更新干员 Box', 'boolean', null, { default: true }),
      field('updateDepot', '更新仓库数据', 'boolean', null, { default: true }),
    ],
  },
  CloseDown: { title: '关闭游戏', fields: [] },
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function clone(value) { return JSON.parse(JSON.stringify(value)) }

function listText(value) {
  return Array.isArray(value) ? value.join(';') : (typeof value === 'string' ? value : '')
}

function valuesFromTask(type, params) {
  const definition = PANELS[type]
  const values = {}
  for (const item of definition.fields) {
    const raw = item.param ? params[item.param] : undefined
    values[item.key] = raw === undefined
      ? clone(item.default)
      : item.kind === 'list' ? listText(raw) : clone(raw)
  }
  return values
}

export function taskPanelFromDocument(document) {
  const tasks = isObject(document) && Array.isArray(document.tasks) ? document.tasks : []
  const onlyDataTasks = tasks.length > 0 && tasks.every(task => task && (task.type === 'OperBox' || task.type === 'Depot'))
  if (onlyDataTasks) {
    const definition = PANELS.UserDataUpdate
    return {
      type: 'UserDataUpdate', title: definition.title, fields: clone(definition.fields),
      values: {
        updateOperBox: tasks.some(task => task.type === 'OperBox'),
        updateDepot: tasks.some(task => task.type === 'Depot'),
      },
    }
  }
  if (tasks.length !== 1 || !tasks[0] || typeof tasks[0].type !== 'string') return null
  const task = tasks[0]
  if (task.type === 'Roguelike') {
    return { type: 'Roguelike', title: '自动肉鸽', fields: [], values: roguelikePanelFromDocument(document) }
  }
  const definition = PANELS[task.type]
  if (!definition) return null
  const params = isObject(task.params) ? task.params : {}
  return { type: task.type, title: definition.title, fields: clone(definition.fields), values: valuesFromTask(task.type, params) }
}

function decoded(raw, label) {
  try { return decodeURIComponent(String(raw ?? '')) } catch { throw new Error(`${label} 的 URL 编码不合法。`) }
}

function coerce(item, raw) {
  if (item.kind === 'boolean') {
    if (raw === true || raw === 'true') return true
    if (raw === false || raw === 'false') return false
    throw new Error(`${item.label}必须是 true 或 false。`)
  }
  if (item.kind === 'integer' || item.kind === 'number') {
    const value = Number(raw)
    if (!Number.isFinite(value) || (item.kind === 'integer' && !Number.isInteger(value)) || value < item.min || value > item.max) {
      throw new Error(`${item.label}必须在 ${item.min}–${item.max} 范围内。`)
    }
    return value
  }
  if (item.kind === 'select') {
    const candidates = item.options.map(entry => entry.value)
    const value = candidates.some(candidate => typeof candidate === 'number') ? Number(raw) : decoded(raw, item.label)
    if (!candidates.includes(value)) throw new Error(`${item.label}不是有效选项。`)
    return value
  }
  if (item.kind === 'multi') {
    const source = Array.isArray(raw) ? raw : String(raw ?? '').split(',').filter(Boolean)
    const numeric = item.options.some(entry => typeof entry.value === 'number')
    const values = source.map(value => numeric ? Number(value) : decoded(value, item.label))
    const candidates = item.options.map(entry => entry.value)
    if (values.some(value => !candidates.includes(value))) throw new Error(`${item.label}包含无效选项。`)
    return [...new Set(values)]
  }
  const value = decoded(raw, item.label).trim()
  if (item.kind === 'list') {
    const values = value === '' ? [] : value.split(/[;；]/u).map(itemValue => itemValue.trim()).filter(Boolean)
    if (values.length > item.maxItems || values.some(itemValue => itemValue.length > item.maxLength)) {
      throw new Error(`${item.label}最多 ${item.maxItems} 项，每项最多 ${item.maxLength} 字。`)
    }
    return values
  }
  if (value.length > item.maxLength) throw new Error(`${item.label}最多 ${item.maxLength} 字。`)
  return value
}

function validateCombination(type, params) {
  if (type === 'Infrast') {
    if (!Array.isArray(params.facility) || params.facility.length === 0) throw new Error('至少选择一个基建设施。')
    if (params.mode === 10000 && !params.filename) throw new Error('自定义排班模式必须选择排班文件。')
  }
  if (type === 'ReclamationAlgorithm') {
    const allowed = params.theme === 'RelaunchAnchor' ? new Set([16, 32, 48]) : new Set([0, 1])
    if (!allowed.has(params.mode)) throw new Error('当前生息演算主题不支持所选模式。')
  }
}

export function applyTaskPanelOverrides(document, overrides) {
  const panel = taskPanelFromDocument(document)
  if (!panel) throw new Error('当前计划没有可编辑的 MAA 参数面板。')
  if (panel.type === 'Roguelike') return applyRoguelikeOverrides(document, overrides)
  const definition = PANELS[panel.type]
  const fields = new Map(definition.fields.map(item => [item.key, item]))
  for (const key of Object.keys(overrides)) if (!fields.has(key)) throw new Error(`当前 ${definition.title} 面板不支持参数：${key}`)

  if (panel.type === 'UserDataUpdate') {
    const values = { ...panel.values }
    const applied = []
    for (const [key, raw] of Object.entries(overrides)) {
      const item = fields.get(key)
      values[key] = coerce(item, raw)
      applied.push(`${item.label}=${values[key] ? '是' : '否'}`)
    }
    if (!values.updateOperBox && !values.updateDepot) throw new Error('更新数据至少选择干员 Box 或仓库中的一项。')
    const tasks = []
    if (values.updateOperBox) tasks.push({ type: 'OperBox' })
    if (values.updateDepot) tasks.push({ type: 'Depot' })
    return { document: { ...document, tasks }, applied }
  }

  const result = clone(document)
  const task = result.tasks[0]
  task.params = isObject(task.params) ? task.params : {}
  const applied = []
  for (const [key, raw] of Object.entries(overrides)) {
    const item = fields.get(key)
    const value = coerce(item, raw)
    if (item.param) task.params[item.param] = value
    applied.push(`${item.label}=${Array.isArray(value) ? value.join('、') : value}`)
  }
  validateCombination(panel.type, task.params)
  return { document: result, applied }
}

export const TASK_PANEL_TYPES = Object.freeze(Object.keys(PANELS))
