import { readStrategyMemory } from './memory.js'

const NUMBER_WORDS = new Map([['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10]])
const CLAUSE_SEPARATORS = new Set(['，', ',', '；', ';', '。', '！', '？', '!', '?', '\n', '\r'])
const CLAUSE_WORDS = ['并且', '然后', '同时', '并']
const PRONOUNS = new Set(['他', '她', '它', '该干员', '这名干员'])
// 「用来堵门」「就去堵门」这类残留的虚词不是干员名；能回退到最近招募的
// 干员就回退，否则整句交回模型，绝不把语气词写进资源文件。
const FILLER_NAMES = new Set([
  '来', '去', '就', '也', '再', '还', '先', '然后', '并', '是', '都',
  '又', '且', '把', '让', '用', '该', '已', '则', '便', '即', '要',
])

export async function parseStrategyNote(note, pending, options = {}) {
  const text = cleanText(note)
  const context = strategyContext(pending)
  const store = await readStrategyMemory({ env: options.env ?? process.env })
  const clauses = splitClauses(text)
  const unresolved = []
  const recognized = []

  if (context.kind === 'Roguelike') {
    const recruitment = { prioritize: [], promote: [], teamComplete: [] }
    const shopping = { prioritize: [], avoid: [] }
    const encounters = []
    let lastOperator = ''
    const tactics = []
    for (const clause of clauses) {
      let match
      const body = clause
        .replace(/^[有带存]\s*[^，。]{0,8}?券\s*[则就便即]?\s*/u, '')
        .replace(/\s*(?:放置|部署|站位|就位)\s*$/u, '')
      if (/^(?:沿用|使用|按)(?:之前|已有|已保存)?(?:的)?(?:肉鸽)?(?:策略|偏好)$/u.test(body)) {
        recognized.push('沿用已启用肉鸽策略')
      } else if ((match = body.match(/^(?:优先)?(?:招募|选择|选|拿|抓|捞|取)(?:干员)?\s*(.+?)(?:\s*(?:用|带)?([123一二三])技能)?$/u))) {
        const item = { name: cleanName(match[1]) }
        const skill = numberValue(match[2])
        if (skill !== undefined) item.skill = skill
        recruitment.prioritize.push(item)
        lastOperator = item.name
        recognized.push(`优先招募 ${item.name}`)
      } else if ((match = body.match(/^(?:(?:优先)?(?:精二|晋升)|(?:精二|晋升)优先)\s*(.+)$/u))) {
        const name = cleanName(match[1])
        recruitment.promote.push({ name })
        recognized.push(`优先精二 ${name}`)
      } else if ((match = body.match(/^(?:不要买|不买|禁买|禁止购买|跳过)\s*(.+)$/u))) {
        const name = cleanName(match[1])
        shopping.avoid.push(name)
        recognized.push(`禁买 ${name}`)
      } else if ((match = body.match(/^(?:优先)?(?:购买|买)\s*(.+)$/u))) {
        const name = cleanName(match[1])
        shopping.prioritize.push(name)
        recognized.push(`优先购买 ${name}`)
      } else if ((match = body.match(/^(?:事件\s*)?(.+?)\s*(?:优先)?(?:选择|选)(?:第)?([1-9一二两三四五六七八九十]+)(?:项|个选项)?$/u))) {
        const name = cleanName(match[1])
        const choose = numberValue(match[2])
        if (!Number.isInteger(choose)) unresolved.push(clause)
        else { encounters.push({ name, choose }); recognized.push(`事件 ${name} 选择第 ${choose} 项`) }
      } else if ((match = body.match(/^(?:在|关卡)\s*(.+?)\s*(?:让|用|把|叫)\s*(.+?)\s*(堵门|守蓝门)\s*(?:\[?(\d+)\s*[,，]\s*(\d+)\]?\s*(?:朝|向|面朝)?\s*(左|右|上|下)?)?$/u))) {
        const tactic = roguelikeTacticClause(match[2], match[1], match[3], match[4], match[5], match[6], lastOperator)
        if (!tactic) unresolved.push(clause)
        else { tactics.push(tactic); recognized.push(describeTactic(tactic)) }
      } else if ((match = body.match(/^(?:让|用|把)\s*(.+?)\s*(?:在|到)\s*(.+?)\s*(堵门|守蓝门)\s*(?:\[?(\d+)\s*[,，]\s*(\d+)\]?\s*(?:朝|向|面朝)?\s*(左|右|上|下)?)?$/u))) {
        const tactic = roguelikeTacticClause(match[1], match[2], match[3], match[4], match[5], match[6], lastOperator)
        if (!tactic) unresolved.push(clause)
        else { tactics.push(tactic); recognized.push(describeTactic(tactic)) }
      } else if ((match = body.match(/^(?:让|用|把)?\s*(.*?)\s*(堵门|守蓝门)\s*(?:\[?(\d+)\s*[,，]\s*(\d+)\]?\s*(?:朝|向|面朝)?\s*(左|右|上|下)?)?$/u))) {
        const tactic = roguelikeTacticClause(match[1], undefined, match[2], match[3], match[4], match[5], lastOperator)
        if (!tactic) unresolved.push(clause)
        else { tactics.push(tactic); recognized.push(describeTactic(tactic)) }
      } else unresolved.push(clause)
    }
    return {
      note: text, context, recognized, unresolved,
      needsModel: unresolved.length > 0,
      input: {
        kind: 'Roguelike', task: context.task,
        recruitment, shopping, encounters, tactics,
        unsupportedRequirements: [],
      },
    }
  }

  if (context.kind === 'Copilot') {
    const tactics = []
    const actions = []
    for (const clause of clauses) {
      let match
      if (/^(?:沿用|使用|按)(?:之前|已有|已保存)?(?:的)?(?:战斗|地图)?(?:策略|打法)$/u.test(clause)) {
        const entries = enabledCombatAtoms(store, context.task.stageName)
        if (entries.length === 0) unresolved.push(clause)
        else {
          for (const atom of entries) {
            if (atom.operation?.startsWith('tactic_')) tactics.push(atom.payload)
            else if (atom.operation === 'action') actions.push(atom.payload)
          }
          recognized.push('沿用已启用战斗策略')
        }
      } else if ((match = clause.match(/^(?:让|用)?\s*(.*?)\s*(堵门|守蓝门)(?:\s*(?:在)?(\d+)\s*杀)?$/u))) {
        const kind = match[2] === '堵门' ? 'block_entrance' : 'guard_blue'
        const remembered = latestTactic(store, kind)
        const name = cleanName(match[1] || remembered?.payload?.name || '')
        if (!name) { unresolved.push(clause); continue }
        const kills = match[3] === undefined ? (remembered?.payload?.kills ?? 0) : Number(match[3])
        tactics.push({ kind, name, kills })
        recognized.push(`${match[2]}：${name}${kills ? `（${kills} 杀）` : ''}`)
      } else if ((match = clause.match(/^(?:(\d+)\s*杀(?:时|后)?\s*)?撤退\s*(.+)$/u))) {
        const name = cleanName(match[2])
        actions.push({ type: 'Retreat', name, ...(match[1] ? { kills: Number(match[1]) } : {}) })
        recognized.push(`${match[1] ? `${match[1]} 杀` : ''}撤退 ${name}`)
      } else if ((match = clause.match(/^(?:(\d+)\s*杀(?:时|后)?\s*)?(?:开|释放|使用)\s*(.+?)(?:的)?技能$/u))) {
        const name = cleanName(match[2])
        actions.push({ type: 'Skill', name, ...(match[1] ? { kills: Number(match[1]) } : {}) })
        recognized.push(`${match[1] ? `${match[1]} 杀` : ''}开启 ${name} 技能`)
      } else if ((match = clause.match(/^(?:(\d+)\s*杀(?:时|后)?\s*)?部署\s*(.+?)\s*(?:在|到)\s*\[?(\d+)\s*[,，]\s*(\d+)\]?(?:\s*(?:朝|向)\s*(左|右|上|下))?$/u))) {
        const name = cleanName(match[2])
        actions.push({
          type: 'Deploy', name, location: [Number(match[3]), Number(match[4])],
          direction: match[5] ?? '无', ...(match[1] ? { kills: Number(match[1]) } : {}),
        })
        recognized.push(`${match[1] ? `${match[1]} 杀` : ''}部署 ${name} @ [${match[3]},${match[4]}]`)
      } else unresolved.push(clause)
    }
    return {
      note: text, context, recognized, unresolved,
      needsModel: unresolved.length > 0,
      input: {
        kind: 'Copilot', task: context.task,
        operators: [], groups: [], tactics, actions, unsupportedRequirements: [],
      },
    }
  }

  return { note: text, context, recognized, unresolved: clauses, needsModel: true, input: null }
}

export function noteModelPrompt(parsed) {
  const task = parsed.context.kind === 'Roguelike'
    ? `肉鸽主题 ${parsed.context.task.theme}，mode=${parsed.context.task.mode ?? 0}`
    : parsed.context.kind === 'Copilot' ? `关卡 ${parsed.context.task.stageName}` : parsed.context.description
  return [
    '请解析下面这条 MAA 任务备注：先识别主语（干员、藏品、事件名，纠正错别字与简称）和动词（抓、拿、捞、取、选、选择、招募都按「招募」理解），把整条备注改写成规范化备注，再调用 maa_prepare_note 生成可预览、需要人工确认的计划；不要直接执行游戏，也不要编造资源里不存在的干员、藏品或分组。',
    '调用 maa_prepare_note 时必须带上下方的确认码（confirmationCode）；肉鸽任务还要带上 theme，确保计划落在当前这个任务上，而不是会话里的其他待确认计划。',
    `当前任务：${task}`,
    parsed.context.confirmationCode ? `确认码：${parsed.context.confirmationCode}` : '',
    `备注：${parsed.note}`,
    parsed.recognized.length ? `本地已识别：${parsed.recognized.join('、')}` : '',
    `仍需解析：${parsed.unresolved.join('、')}`,
    parsed.context.kind === 'Roguelike'
      ? '肉鸽的堵门/守蓝门写在 autopilot 关卡配置里：不写关卡名时，插件会对该主题所有原生关卡按地图数据自动选点并写入 deploy_plan，不需要坐标和朝向；只在用户点名了某个关卡时才要求给出部署坐标和朝向（例如「在暗箭难防让结城理堵门 [3,1] 朝下」），其余情况不要猜测坐标。'
      : '',
  ].filter(Boolean).join('\n')
}

function strategyContext(pending) {
  const confirmationCode = pending?.confirmationCode
  if (pending?.strategy?.kind === 'Roguelike') return { kind: 'Roguelike', task: { ...pending.strategy.step }, description: '肉鸽策略', confirmationCode }
  if (pending?.strategy?.kind === 'Copilot') return { kind: 'Copilot', task: { stageName: pending.strategy.stageName, formation: pending.strategy.formation }, description: 'Copilot 策略', confirmationCode }
  const tasks = Array.isArray(pending?.document?.tasks) ? pending.document.tasks : []
  const rogue = tasks.find(item => item?.type === 'Roguelike')
  if (rogue) {
    const params = rogue.params ?? {}
    return {
      kind: 'Roguelike', description: '肉鸽任务', confirmationCode,
      task: {
        theme: params.theme, mode: params.mode ?? 0, startsCount: params.starts_count ?? 1,
        ...(params.difficulty !== undefined ? { difficulty: params.difficulty } : {}),
        ...(params.squad ? { squad: params.squad } : {}), ...(params.core_char ? { coreChar: params.core_char } : {}),
        ...(params.roles ? { roles: params.roles } : {}), ...(params.use_support !== undefined ? { useSupport: params.use_support } : {}),
        ...(params.use_nonfriend_support !== undefined ? { useNonFriendSupport: params.use_nonfriend_support } : {}),
      },
    }
  }
  const fight = tasks.find(item => item?.type === 'Fight')
  if (fight?.params?.stage) return { kind: 'Copilot', task: { stageName: fight.params.stage, formation: true }, description: `作战 ${fight.params.stage}`, confirmationCode }
  return { kind: 'Unsupported', task: {}, description: tasks.map(item => item?.type).filter(Boolean).join(' → ') || '未知任务', confirmationCode }
}

function enabledCombatAtoms(store, stageName) {
  return (store.categories.combat ?? []).filter(entry => entry.enabled !== false && entry.source === 'strategy')
    .map(entry => entry.atom).filter(atom => atom?.operation?.startsWith('tactic_') || (atom?.operation === 'action' && atom?.applicability?.stageName === stageName))
}

function latestTactic(store, kind) {
  return (store.categories.combat ?? []).findLast(entry => entry.enabled !== false && entry.semanticKey === `tactic:${kind}`)?.atom ?? null
}

function roguelikeTacticClause(rawName, stageName, word, x, y, facing, lastOperator = '') {
  let name = cleanName(rawName)
  if ((PRONOUNS.has(name) || FILLER_NAMES.has(name)) && lastOperator) name = lastOperator
  // 「用来堵门」把「来」留在了干员位：没有可回退的干员时必须交回模型，
  // 而不是把一个语气词当成干员写进资源。
  if (!name || FILLER_NAMES.has(name)) return null
  const tactic = { kind: word === '堵门' ? 'block_entrance' : 'guard_blue', name }
  const stage = cleanName(stageName ?? '')
  if (stage) tactic.stageName = stage
  if (x !== undefined && y !== undefined) tactic.location = [Number(x), Number(y)]
  if (facing) tactic.direction = facing
  return tactic
}

function splitClauses(text) {
  const parts = []
  let current = ''
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '[' || char === '【' || char === '（' || char === '(') { depth += 1; current += char; continue }
    if (char === ']' || char === '】' || char === '）' || char === ')') { depth = Math.max(0, depth - 1); current += char; continue }
    if (depth === 0) {
      if (CLAUSE_SEPARATORS.has(char)) { parts.push(current); current = ''; continue }
      const word = CLAUSE_WORDS.find(item => text.startsWith(item, index))
      if (word) { parts.push(current); current = ''; index += word.length - 1; continue }
    }
    current += char
  }
  parts.push(current)
  return parts.map(cleanClause).filter(Boolean)
}

function describeTactic(tactic) {
  const label = tactic.kind === 'block_entrance' ? '堵门' : '守蓝门'
  const place = tactic.stageName ? ` @ ${tactic.stageName}` : ''
  const spot = tactic.location ? ` [${tactic.location.join(',')}]` : ''
  const facing = tactic.direction ? ` 朝${tactic.direction}` : ''
  return `${label}：${tactic.name}${place}${spot}${facing}`
}

function cleanText(value) {
  const result = String(value ?? '').replace(/[\r\n\t]+/gu, ' ').trim()
  if (result === '' || result.length > 120) throw new Error('备注必须是 1–120 个字符。')
  return result
}
function cleanClause(value) { return String(value).replace(/^(?:请|麻烦|帮我|要求)\s*/u, '').trim() }
function cleanName(value) { return String(value ?? '').replace(/^[“”"'\s]+|[“”"'\s]+$/gu, '').trim() }
function numberValue(value) { if (value === undefined) return undefined; if (/^\d+$/u.test(value)) return Number(value); return NUMBER_WORDS.get(value) }
