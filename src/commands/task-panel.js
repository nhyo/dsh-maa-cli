import { applyRoguelikeOverrides, recruitSummary, roguelikePanelFromDocument } from './planner.js'
import { fallbackCapabilities, findRoguelikeTheme } from '../capabilities/discovery.js'

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
// The roguelike difficulty field offers a synthetic MAX value: the panel shows
// it as the theme's highest difficulty, and the confirm handler resolves it
// against the theme MAA will actually run (planner.js coerceOverride).
const MAX_DIFFICULTY = 'MAX'

function option(value, label, extra = {}) { return { value, label, ...extra } }
function options(entries) { return entries.map(([value, label]) => option(value, label)) }
function field(key, label, kind, param, extra = {}) {
  const required = kind === 'select' || kind === 'integer' || kind === 'number' || kind === 'boolean'
  return { key, label, kind, param, required, ...extra }
}
function note(text, when) { return when ? { text, when } : { text } }

const PANELS = {
  StartUp: {
    title: '开始唤醒',
    fields: [
      field('clientType', '客户端', 'select', 'client_type', { options: options(CLIENT_OPTIONS), default: 'Official' }),
      field('startGameEnabled', '自动启动游戏', 'boolean', 'start_game_enabled', { default: true }),
      field('accountName', '切换账号（可留空）', 'text', 'account_name', {
        default: '', maxLength: 64,
        description: '填写登录界面能看到的账号片段，留空则不切换。官服、B 服可填手机号掩码或其中一段；繁中服、韩服可填 Email 的明文片段。不支持第三方登录方式。',
      }),
    ],
  },
  Fight: {
    title: '理智作战',
    fields: [
      field('stage', '关卡', 'text', 'stage', {
        default: '', maxLength: 32, placeholder: '留空＝当前/上次关卡',
        description: '支持大部分主线和资源关卡名，例如 4-10、AP-5、H10-1-Hard；关卡末尾可加 Normal/Hard 切换难度。',
      }),
      field('times', '作战次数', 'integer', 'times', {
        default: 1, min: 1, max: 100,
        description: '只需填写总次数：插件让 MAA 自动选择代理倍率分组，理智不足一整组时自动减少，最后一组按剩余次数执行。',
      }),
      field('medicine', '理智药上限', 'integer', 'medicine', { default: 0, min: 0, max: 99 }),
      field('medicineExpireDays', '使用几天内过期理智药', 'integer', 'medicine_expire_days', {
        default: 0, min: 0, max: 99,
        description: '只使用游戏内显示不足 N 天的理智药；显示“N 天”及以上的不使用。',
      }),
      field('stone', '源石上限', 'integer', 'stone', {
        default: 0, min: 0, max: 20,
        description: '本次任务最多使用的源石数量。0 表示绝不使用源石。',
      }),
      field('drops', '掉落目标（任一达到即停）', 'list', 'drops', {
        default: '', maxItems: 10, maxLength: 40, placeholder: '固源岩组=3；装置=2', dropsMap: true,
        description: '按 MAA 物品名或物品 ID 填写“名称=数量”，用分号分隔；任一物品达到数量时停止作战，留空则只按次数。',
      }),
      field('drGrandet', '博朗台模式', 'boolean', 'DrGrandet', {
        default: false, advanced: true,
        description: '在恢复理智确认界面等待，直到当前 1 点理智自然恢复完成，再立即确认。',
      }),
    ],
  },
  Infrast: {
    title: '基建换班',
    fields: [
      field('mode', '换班模式', 'select', 'mode', { default: 0, options: options([[0, '常规模式'], [10000, '自定义排班'], [20000, '队列轮换']]) }),
      field('facilities', '处理设施', 'multi', 'facility', {
        default: FACILITY_OPTIONS.map(item => item[0]), options: options(FACILITY_OPTIONS), required: true,
        description: '常规模式的换班顺序由算法统一安排，此处只选择设施类别，勾选顺序不生效；需要自定义顺序时使用自定义排班。',
      }),
      field('drones', '无人机用途', 'select', 'drones', { default: '_NotUse', options: options(DRONE_OPTIONS), when: { key: 'mode', notEquals: 10000 } }),
      field('threshold', '工作心情阈值', 'number', 'threshold', {
        default: 0.3, min: 0, max: 1, step: 0.05, when: { key: 'mode', notEquals: 20000 },
        description: '自定义换班时，该值只对 autofill 和使用干员编组的房间生效。',
      }),
      field('replenish', '源石碎片自动补货', 'boolean', 'replenish', { default: false }),
      field('dormNotStationed', '宿舍不放入已进驻干员', 'boolean', 'dorm_notstationed_enabled', {
        default: false, advanced: true,
        description: '可避免把艾丽妮等干员从训练室移走，但也会导致加工站中的干员不能进入宿舍。',
      }),
      field('dormTrust', '宿舍信赖补位', 'boolean', 'dorm_trust_enabled', { default: false, advanced: true }),
      field('receptionMessageBoard', '领取会客室信息板信用', 'boolean', 'reception_message_board', { default: true, advanced: true }),
      field('receptionClueExchange', '进行线索交流', 'boolean', 'reception_clue_exchange', {
        default: true, advanced: true,
        description: '若无法开启交流，换班时会取下线索板上的全部线索；若能开启，则使用一键放置。个人线索上限为 10 张，提前放入过多可能导致无法一键赠送或获取新线索。',
      }),
      field('receptionSendClue', '赠送线索', 'boolean', 'reception_send_clue', { default: true, advanced: true }),
      field('continueTraining', '继续未完成专精训练', 'boolean', 'continue_training', { default: false, advanced: true }),
      field('filename', '自定义排班文件', 'text', 'filename', { default: '', maxLength: 260, required: true, when: { key: 'mode', equals: 10000 } }),
      field('planIndex', '排班方案序号', 'integer', 'plan_index', { default: 0, min: 0, max: 999, when: { key: 'mode', equals: 10000 } }),
    ],
    notes: [
      note('队列轮换与游戏内基建右下角的同名功能一致：当前班次任意干员心情为 0 时，整队替换为下一班。使用前需先在游戏中设置好队列；需要自定义班次时请选择“自定义排班”。', { key: 'mode', equals: 20000 }),
      note('自定义排班按所选 JSON 文件和方案序号执行。若方案设置了执行时间，任务运行中不会自动切换方案，只会在空闲或任务完成后切换。', { key: 'mode', equals: 10000 }),
    ],
  },
  Recruit: {
    title: '自动公招',
    fields: [
      field('refresh', '刷新三星 Tags', 'boolean', 'refresh', { default: false }),
      field('select', '自动选择的 Tag 星级', 'multi', 'select', { default: [4, 5, 6], options: options(STAR_OPTIONS) }),
      field('confirm', '自动确认的 Tag 星级', 'multi', 'confirm', {
        default: [3, 4], options: options(STAR_OPTIONS),
        description: 'MAA 只会对勾选的星级点“开始招募”；全部不勾选则只识别 Tag、不招募。默认与 MAA 图形界面一致只确认 3★/4★，出现 5★/6★ 组合时跳过该栏位，留给你手动处理。',
      }),
      field('times', '招募次数（0＝仅识别）', 'integer', 'times', { default: 4, min: 0, max: 4 }),
      field('setTime', '自动设置招募时限', 'boolean', 'set_time', { default: true }),
      field('expedite', '使用加急许可', 'boolean', 'expedite', {
        default: false,
        description: '只对本次任务生效。正常情况下下一轮公招时自然已到招募时间，建议仅在招募许可严重溢出等应急场景使用。',
      }),
      field('permitReserve', '三星保留招聘许可数', 'integer', 'level3_recruitment_permit_reserve', {
        default: 0, min: 0, max: 999, advanced: true,
        description: '剩余招聘许可小于或等于该值时，跳过 3 星招聘。',
      }),
      field('firstTags', '三星首选 Tags', 'list', 'first_tags', { default: '', maxItems: 10, maxLength: 24, advanced: true, placeholder: '用分号分隔' }),
      field('preserveTags', '保留并跳过的 Tags', 'list', 'preserve_tags', {
        default: '支援机械', maxItems: 10, maxLength: 24, advanced: true, placeholder: '用分号分隔',
        description: '识别到任一指定词条时跳过该次招募并保留栏位；留空则不保留任何词条。',
      }),
      field('extraTagsMode', '额外选择 Tags', 'select', 'extra_tags_mode', {
        default: 0, advanced: true, options: options([[0, '默认'], [1, '选满 3 个'], [2, '尽量选择更多高星组合']]),
        description: '启用后会尽可能多地选择倾向的 Tag。',
      }),
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
      field('onlyBuyDiscount', '仅购买折扣商品', 'boolean', 'only_buy_discount', {
        default: false, advanced: true,
        description: '可能导致信用点溢出；白名单中的物品即使没有折扣仍会购买。',
      }),
      field('reserveMaxCredit', '信用低于 300 时停止购买', 'boolean', 'reserve_max_credit', {
        default: false, advanced: true,
        description: '白名单中的物品不受此限制，低于 300 信用点时仍可能购买。',
      }),
      field('creditFight', '借助战通关 OF-1', 'boolean', 'credit_fight', {
        default: false, advanced: true,
        description: '访问好友后借助战打一把 OF-1，获得 30 信用。未解锁“火蓝之心”OF-1 时不要启用。',
      }),
      field('formationIndex', '助战关卡编队', 'select', 'formation_index', { default: 0, advanced: true, when: { key: 'creditFight', equals: true }, options: options([[0, '当前编队'], [1, '第一编队'], [2, '第二编队'], [3, '第三编队'], [4, '第四编队']]) }),
    ],
  },
  Award: {
    title: '领取奖励',
    fields: [
      field('dailyWeekly', '每日/每周任务奖励', 'boolean', 'award', { default: true }),
      field('mail', '领取邮件奖励', 'boolean', 'mail', { default: false }),
      field('freePull', '限时寻访免费单抽', 'boolean', 'recruit', {
        default: false,
        description: '没有免费单抽时不会抽取。该功能仍存在误抽风险，启用即表示接受这一风险。',
      }),
      field('orundum', '幸运墙合成玉', 'boolean', 'orundum', { default: false }),
      field('mining', '限时开采许可', 'boolean', 'mining', { default: false }),
      field('specialAccess', '特殊月卡奖励', 'boolean', 'specialaccess', { default: false }),
      field('signInEvent', '限时签到活动', 'boolean', 'signinevent', {
        default: false,
        description: '仅支持常见横向版型；其他版型可能无法正常运作。',
      }),
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
    notes: [
      note('目前生息演算支持仍处于中期阶段，不建议无人值守。\n\n无存档刷点：会通过开局和进出关卡刷生息点；点数刷满后自动结束。使用前请确认并删除已有存档，清空生息演算编队，并从生息演算主界面开始，否则可能误删存档或导航失败。', { key: 'mode', equals: 0 }),
      note('目前生息演算支持仍处于中期阶段，不建议无人值守。\n\n有存档制造刷点：需处于结算后的第一天，后续三天不能有敌袭进入驻扎地，并从能看到驻扎地的大地图界面开始。制造物品留空时默认使用荧光棒；可制造数量恰好为 99 的倍数时可能卡住，建议存档前先消耗少量。', { key: 'mode', equals: 1 }),
      note('RA-1 自动循环\n收益参考：每轮约 159 代币和统筹点数，约 2 分 10 秒；无干员要求。\n前置：主线 RA-1 已通关。在大地图打开 RA-1，右下角出现“开启建设”时启动。若科技会让开局额外携带物品，请先拆除食品供给站、饮品供给站、兽栏等相关设施。流程为精耕细作、建设、交付资源和结算循环。', { key: 'mode', equals: 16 }),
      note('RA-15 60 杀\n收益参考：每轮约 500 代币和统筹点数，约 3 分钟；需要圣聆初雪，可借助战。\n前置：RA-15 已通关；自有干员时预先保存“五先锋＋圣聆初雪（第六位）”编队，借助战时确保她位于术师助战首页。在大地图打开 RA-15，出现“开启建设”时启动。请拆除会让开局额外携带物品的相关设施。', { key: 'mode', equals: 32 }),
      note('RA-4 解锁与击杀\n收益参考：每轮约 417 代币和统筹点数，约 1 分 40 秒；需要维什戴尔，可借助战。\n前置：RA-4 已通关并解锁“策略筹划经营”。预先手动编入 5 名费用低于维什戴尔的干员，维什戴尔放第六位；使用助战时让第六位保持为空并确保助战位于狙击首页。放弃本次建设后回到“开始建设”，再启动任务。请拆除会让开局额外携带物品的相关设施。', { key: 'mode', equals: 48 }),
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

function valuesFromTask(type, params, context = {}) {
  const definition = PANELS[type]
  const values = {}
  for (const item of definition.fields) {
    const raw = item.param ? params[item.param] : undefined
    values[item.key] = raw === undefined
      ? clone(item.default)
      : item.dropsMap ? dropsText(raw, context.itemIndex)
        : item.kind === 'list' ? listText(raw) : clone(raw)
  }
  return values
}

function dropsText(value, itemIndex) {
  if (!isObject(value)) return ''
  return Object.entries(value).map(([id, count]) => `${itemIndex?.byId?.get(id)?.name ?? id}=${count}`).join(';')
}

// "固源岩组=3；装置=2" → { "30013": 3, "30062": 2 } using MAA's item_index.json.
export function parseDropTargets(entries, itemIndex) {
  const result = {}
  for (const entry of entries) {
    const match = String(entry).match(/^(.+?)\s*[=＝:：×xX*]\s*(\d{1,5})$/u)
    if (!match) throw new Error(`掉落目标“${entry}”格式应为 名称=数量。`)
    const id = resolveItemId(match[1].trim(), itemIndex)
    result[id] = (result[id] ?? 0) + Number(match[2])
  }
  return result
}

export function resolveItemId(raw, itemIndex) {
  if (!itemIndex?.byId) throw new Error('无法读取 MAA 物品索引（item_index.json），不能设置掉落目标。')
  const value = String(raw ?? '').trim()
  if (itemIndex.byId.has(value)) return value
  const found = itemIndex.byName.get(value.toLocaleLowerCase('zh-CN'))
  if (found) return found.id
  throw new Error(`MAA 物品索引中找不到“${value}”，请使用游戏内的物品全名。`)
}

const STEP_LABELS = {
  Roguelike: '自动肉鸽', Copilot: '自动战斗作业', SSSCopilot: '保全派驻作业', Depot: '识别仓库', OperBox: '识别干员',
  Custom: '自定义 MaaCore 任务', CloseDown: '关闭游戏',
}

// Plans without an editable panel (several steps, or a task type such as
// Copilot that has no parameter panel) still need a confirmation surface: a
// read-only step list with no fields, so the confirm button submits no
// overrides and executes exactly the prepared plan.
export function readOnlyPlanPanel(document) {
  const tasks = isObject(document) && Array.isArray(document.tasks) ? document.tasks : []
  return {
    type: 'Plan', title: tasks.length > 1 ? `MAA 计划（${tasks.length} 步）` : 'MAA 计划', fields: [], values: {},
    notes: tasks.map((task, index) => note(`${index + 1}. ${PANELS[task?.type]?.title ?? STEP_LABELS[task?.type] ?? String(task?.type ?? '未知任务')}${stepDetail(task)}`)),
  }
}

function stepDetail(task) {
  const params = isObject(task?.params) ? task.params : {}
  if (task?.type === 'Fight') return `：${params.stage || '当前关卡'} ×${params.times ?? '?'}${params.drops ? '，有掉落目标' : ''}${params.medicine ? `，理智药 ${params.medicine}` : ''}${params.stone ? `，源石 ${params.stone}` : ''}`
  if (task?.type === 'Recruit') return `：${recruitSummary(params.times ?? 0, Array.isArray(params.confirm) ? params.confirm : [], params.expedite === true).replace(/^公招/u, '')}`
  if (task?.type === 'Infrast') return params.mode === 10000 ? '：自定义排班' : params.mode === 20000 ? '：队列轮换' : ''
  if (task?.type === 'Copilot') return params.copilot_list?.[0]?.stage_name ? `：${params.copilot_list[0].stage_name}` : '：当前关卡'
  return ''
}

export function taskPanelFromDocument(document, capabilities = fallbackCapabilities(), context = {}) {
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
    return roguelikePanel(document, capabilities)
  }
  const definition = PANELS[task.type]
  if (!definition) return null
  const params = isObject(task.params) ? task.params : {}
  return {
    type: task.type,
    title: definition.title,
    fields: clone(definition.fields),
    notes: clone(definition.notes ?? []),
    values: valuesFromTask(task.type, params, context),
  }
}

function decoded(raw, label) {
  try { return decodeURIComponent(String(raw ?? '')) } catch { throw new Error(`${label} 的 URL 编码不合法。`) }
}

function coerce(item, raw, context = {}) {
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
    return item.dropsMap ? parseDropTargets(values, context.itemIndex) : values
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

export function applyTaskPanelOverrides(document, overrides, capabilities = fallbackCapabilities(), context = {}) {
  const panel = taskPanelFromDocument(document, capabilities, context)
  if (!panel) throw new Error('当前计划没有可编辑的 MAA 参数面板。')
  const normalizedOverrides = applyUnset(panel, overrides)
  if (panel.type === 'Roguelike') return applyRoguelikeOverrides(document, normalizedOverrides, capabilities)
  const definition = PANELS[panel.type]
  const fields = new Map(definition.fields.map(item => [item.key, item]))
  for (const key of Object.keys(normalizedOverrides)) if (!fields.has(key)) throw new Error(`当前 ${definition.title} 面板不支持参数：${key}`)

  if (panel.type === 'UserDataUpdate') {
    const values = { ...panel.values }
    const applied = []
    for (const [key, raw] of Object.entries(normalizedOverrides)) {
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
  for (const [key, raw] of Object.entries(normalizedOverrides)) {
    const item = fields.get(key)
    const value = coerce(item, raw, context)
    if (item.param) {
      if (!item.required && emptyValue(value)) delete task.params[item.param]
      else task.params[item.param] = value
    }
    applied.push(`${item.label}=${Array.isArray(value) ? value.join('、') : isObject(value) ? dropsText(value, context.itemIndex) || '无' : value}`)
  }
  validateCombination(panel.type, task.params)
  // Battles are always grouped automatically; the panel has no series field.
  if (panel.type === 'Fight') task.params.series = 0
  return { document: result, applied }
}

export const TASK_PANEL_TYPES = Object.freeze(Object.keys(PANELS))

function applyUnset(panel, overrides) {
  const result = { ...(isObject(overrides) ? overrides : {}) }
  const raw = result._unset
  delete result._unset
  if (raw === undefined || raw === '') return result
  const fields = new Map((panel.fields ?? []).map(item => [item.key, item]))
  const keys = String(raw).split(',').filter(Boolean).map(key => decoded(key, '清除参数'))
  for (const key of keys) {
    const item = fields.get(key)
    if (!item) throw new Error(`当前 ${panel.title} 面板不支持清除参数：${key}`)
    if (item.required === true) throw new Error(`${item.label}是必填参数，不能清除。`)
    result[key] = ''
  }
  return result
}

function roguelikePanel(document, capabilities) {
  const current = roguelikePanelFromDocument(document) ?? {}
  const themes = capabilities?.roguelike?.themes ?? []
  if (themes.length === 0) throw new Error('当前 MAA 能力描述中没有可用肉鸽主题。')
  const selected = findRoguelikeTheme(capabilities, current.theme) ?? themes[0]
  const defaults = selected.defaults ?? {}
  const modeOptions = []
  const difficultyOptions = []
  const squadOptions = []
  const roleOptions = []
  const operatorOptions = []
  for (const theme of themes) {
    for (const mode of theme.modes ?? []) pushScoped(modeOptions, mode.value, mode.label, theme.id)
    if ((theme.difficulties ?? []).length > 0) pushScoped(difficultyOptions, MAX_DIFFICULTY, 'MAX（当前最高）', theme.id)
    for (const difficulty of theme.difficulties ?? []) pushScoped(difficultyOptions, difficulty, String(difficulty), theme.id)
    for (const value of theme.squads ?? []) pushScoped(squadOptions, value, recommended(value, theme.defaults?.squad), theme.id)
    for (const value of theme.roles ?? []) pushScoped(roleOptions, value, recommended(value, theme.defaults?.roles), theme.id)
    for (const value of theme.operators ?? []) pushScoped(operatorOptions, value, recommended(value, theme.defaults?.coreChar), theme.id)
  }
  const currentMatchesTheme = current.theme === selected.id
  const selectedMode = scopedValue(modeOptions, selected.id, currentMatchesTheme ? current.mode : undefined, defaults.mode, true)
  const themeDifficulties = (selected.difficulties ?? []).filter(item => Number.isFinite(item))
  const selectedDifficulty = scopedValue(
    difficultyOptions,
    selected.id,
    currentMatchesTheme ? current.difficulty : undefined,
    themeDifficulties.length > 0 ? MAX_DIFFICULTY : undefined,
    true,
  )
  const selectedSquad = scopedValue(squadOptions, selected.id, currentMatchesTheme ? current.squad : undefined, defaults.squad, false)
  const selectedRoles = scopedValue(roleOptions, selected.id, currentMatchesTheme ? current.roles : undefined, defaults.roles, false)
  const selectedOperator = scopedValue(operatorOptions, selected.id, currentMatchesTheme ? current.coreChar : undefined, defaults.coreChar, false)
  const advanced = [
    field('useNonFriendSupport', '使用非好友助战', 'boolean', 'use_nonfriend_support', { default: false, advanced: true, when: { key: 'useSupport', equals: true } }),
    field('stopAtFinalBoss', '打到最终 Boss 停', 'boolean', 'stop_at_final_boss', { default: false, advanced: true, when: { key: 'supportsFinalBossStop', equals: true } }),
    field('stopAtMaxLevel', '等级刷满停', 'boolean', 'stop_at_max_level', { default: false, advanced: true }),
    field('investmentEnabled', '投资源石锭', 'boolean', 'investment_enabled', { default: true, advanced: true }),
    field('investmentsCount', '投资次数', 'integer', 'investments_count', { default: 999, min: 0, max: 99999, advanced: true, when: { key: 'investmentEnabled', equals: true } }),
    field('stopWhenInvestmentFull', '投资满停', 'boolean', 'stop_when_investment_full', { default: false, advanced: true, when: { key: 'investmentEnabled', equals: true } }),
    field('investmentWithMoreScore', '投资后购物', 'boolean', 'investment_with_more_score', { default: false, advanced: true, when: { key: 'mode', equals: 1 } }),
    field('startWithEliteTwo', '凹精二直升', 'boolean', 'start_with_elite_two', { default: false, advanced: true, when: { key: 'mode', equals: 4 } }),
    field('onlyStartWithEliteTwo', '只凹精二直升', 'boolean', 'only_start_with_elite_two', { default: false, advanced: true, when: { all: [{ key: 'mode', equals: 4 }, { key: 'startWithEliteTwo', equals: true }] } }),
    field('monthlySquadAutoIterate', '月度小队自动切换', 'boolean', 'monthly_squad_auto_iterate', { default: false, advanced: true, when: { key: 'mode', equals: 6 } }),
    field('deepExplorationAutoIterate', '深入调查自动切换', 'boolean', 'deep_exploration_auto_iterate', { default: false, advanced: true, when: { key: 'mode', equals: 7 } }),
    field('findPlayTimeTarget', '常乐节点', 'select', 'find_playTime_target', { default: 1, advanced: true, when: { key: 'mode', equals: 20001 }, options: options([[1, '令（掷地有声）'], [2, '黍（种因得果）'], [3, '年（三缺一）']]) }),
    field('useFoldartal', '使用密文板', 'boolean', 'use_foldartal', { default: false, advanced: true, when: { key: 'supportsFoldartal', equals: true } }),
    field('checkCollapsalParadigms', '检测坍缩范式', 'boolean', 'check_collapsal_paradigms', { default: false, advanced: true, when: { key: 'supportsFoldartal', equals: true } }),
    field('refreshTraderWithDice', '骰子刷新商店', 'boolean', 'refresh_trader_with_dice', { default: false, advanced: true, when: { key: 'supportsDiceRefresh', equals: true } }),
  ]
  const reset = {
    mode: 0, stopAtFinalBoss: false, useFoldartal: false, checkCollapsalParadigms: false,
    refreshTraderWithDice: false, investmentWithMoreScore: false, startWithEliteTwo: false,
    onlyStartWithEliteTwo: false, monthlySquadAutoIterate: false, deepExplorationAutoIterate: false,
  }
  return {
    type: 'Roguelike', title: '自动肉鸽', capabilitySignature: capabilities.signature ?? '', capabilitySource: capabilities.source ?? 'adapter',
    fields: [
      field('theme', '主题', 'select', 'theme', { default: selected.id, options: themes.map(theme => option(theme.id, theme.label, { patch: { ...reset, theme: theme.id, ...validThemeDefaults(theme), ...featureValues(theme) } })) }),
      field('mode', '模式', 'select', 'mode', { default: selectedMode, options: modeOptions }),
      field('difficulty', '难度', 'select', 'difficulty', { default: selectedDifficulty, options: difficultyOptions }),
      field('startsCount', '刷取次数', 'integer', 'starts_count', { default: 9999, min: 1, max: 99999 }),
      field('squad', '分队', 'select', 'squad', { default: selectedSquad, required: false, options: squadOptions }),
      field('roles', '职业组', 'select', 'roles', { default: selectedRoles, required: false, options: roleOptions }),
      field('coreChar', '开局干员', 'select', 'core_char', { default: selectedOperator, required: false, options: operatorOptions }),
      field('useSupport', '使用助战', 'boolean', 'use_support', { default: defaults.useSupport === true }),
      ...advanced,
    ],
    notes: capabilities.warning ? [note(capabilities.warning)] : [],
    values: {
      theme: selected.id, mode: selectedMode,
      startsCount: currentMatchesTheme ? current.startsCount ?? 9999 : 9999,
      ...featureValues(selected),
      difficulty: selectedDifficulty,
      squad: selectedSquad, roles: selectedRoles,
      coreChar: selectedOperator, useSupport: currentMatchesTheme ? current.useSupport ?? defaults.useSupport === true : defaults.useSupport === true,
      useNonFriendSupport: current.useNonFriendSupport === true, stopAtFinalBoss: current.stopAtFinalBoss === true,
      stopAtMaxLevel: current.stopAtMaxLevel === true, investmentEnabled: current.investmentEnabled !== false,
      investmentsCount: current.investmentsCount ?? 999, stopWhenInvestmentFull: current.stopWhenInvestmentFull === true,
      investmentWithMoreScore: current.investmentWithMoreScore === true, startWithEliteTwo: current.startWithEliteTwo === true,
      onlyStartWithEliteTwo: current.onlyStartWithEliteTwo === true, monthlySquadAutoIterate: current.monthlySquadAutoIterate === true,
      deepExplorationAutoIterate: current.deepExplorationAutoIterate === true, findPlayTimeTarget: current.findPlayTimeTarget ?? 1,
      useFoldartal: current.useFoldartal === true, checkCollapsalParadigms: current.checkCollapsalParadigms === true,
      refreshTraderWithDice: current.refreshTraderWithDice === true, note: '',
    },
  }
}

function pushScoped(target, value, label, theme) {
  let entry = target.find(item => item.value === value && item.label === label)
  if (!entry) { entry = option(value, label, { when: { key: 'theme', in: [] } }); target.push(entry) }
  if (!entry.when.in.includes(theme)) entry.when.in.push(theme)
}
function scopedValue(options, theme, current, fallback, required) {
  const available = options.filter(item => item.when?.in?.includes(theme)).map(item => item.value)
  if (available.some(value => value === current)) return current
  if (available.some(value => value === fallback)) return fallback
  return required ? available[0] : ''
}
function validThemeDefaults(theme) {
  const defaults = theme?.defaults ?? {}
  const choose = (values, value) => Array.isArray(values) && values.includes(value) ? value : ''
  const modes = (theme?.modes ?? []).map(item => item.value)
  return {
    mode: modes.includes(defaults.mode) ? defaults.mode : modes[0],
    difficulty: (theme?.difficulties ?? []).length > 0 ? MAX_DIFFICULTY : undefined,
    squad: choose(theme?.squads, defaults.squad), roles: choose(theme?.roles, defaults.roles),
    coreChar: choose(theme?.operators, defaults.coreChar), useSupport: defaults.useSupport === true,
  }
}
function recommended(value, expected) { return value === expected ? `${value}【推荐】` : value }
function featureValues(theme) {
  return {
    supportsFinalBossStop: theme?.features?.stopAtFinalBoss === true,
    supportsFoldartal: theme?.features?.foldartal === true,
    supportsDiceRefresh: theme?.features?.refreshTraderWithDice === true,
  }
}
function emptyValue(value) { return value === '' || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0) }
