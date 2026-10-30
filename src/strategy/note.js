import { readStrategyMemory } from './memory.js'

const NUMBER_WORDS = new Map([['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10]])

export async function parseStrategyNote(note, pending, options = {}) {
  const text = cleanText(note)
  const context = strategyContext(pending)
  const store = await readStrategyMemory({ env: options.env ?? process.env })
  const clauses = text.split(/(?:[，,；;。！？!?\n]+|\s*(?:然后|同时|并且)\s*)/u).map(cleanClause).filter(Boolean)
  const unresolved = []
  const recognized = []

  if (context.kind === 'Roguelike') {
    const recruitment = { prioritize: [], promote: [], teamComplete: [] }
    const shopping = { prioritize: [], avoid: [] }
    const encounters = []
    for (const clause of clauses) {
      let match
      if (/^(?:沿用|使用|按)(?:之前|已有|已保存)?(?:的)?(?:肉鸽)?(?:策略|偏好)$/u.test(clause)) {
        recognized.push('沿用已启用肉鸽策略')
      } else if ((match = clause.match(/^(?:优先)?(?:招募|选择|选|拿)(?:干员)?\s*(.+?)(?:\s*(?:用|带)?([123一二三])技能)?$/u))) {
        const item = { name: cleanName(match[1]) }
        const skill = numberValue(match[2])
        if (skill !== undefined) item.skill = skill
        recruitment.prioritize.push(item)
        recognized.push(`优先招募 ${item.name}`)
      } else if ((match = clause.match(/^(?:(?:优先)?(?:精二|晋升)|(?:精二|晋升)优先)\s*(.+)$/u))) {
        const name = cleanName(match[1])
        recruitment.promote.push({ name })
        recognized.push(`优先精二 ${name}`)
      } else if ((match = clause.match(/^(?:不要买|不买|禁买|禁止购买|跳过)\s*(.+)$/u))) {
        const name = cleanName(match[1])
        shopping.avoid.push(name)
        recognized.push(`禁买 ${name}`)
      } else if ((match = clause.match(/^(?:优先)?(?:购买|买)\s*(.+)$/u))) {
        const name = cleanName(match[1])
        shopping.prioritize.push(name)
        recognized.push(`优先购买 ${name}`)
      } else if ((match = clause.match(/^(?:事件\s*)?(.+?)\s*(?:优先)?(?:选择|选)(?:第)?([1-9一二两三四五六七八九十]+)(?:项|个选项)?$/u))) {
        const name = cleanName(match[1])
        const choose = numberValue(match[2])
        if (!Number.isInteger(choose)) unresolved.push(clause)
        else { encounters.push({ name, choose }); recognized.push(`事件 ${name} 选择第 ${choose} 项`) }
      } else unresolved.push(clause)
    }
    return {
      note: text, context, recognized, unresolved,
      needsModel: unresolved.length > 0,
      input: {
        kind: 'Roguelike', task: context.task,
        recruitment, shopping, encounters,
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
    '请解析下面这条 MAA 任务备注。只处理本地规则无法确定的部分，并使用 maa_prepare_strategy 重新生成可预览、需要人工确认的计划；不要直接执行游戏。',
    `当前任务：${task}`,
    `备注：${parsed.note}`,
    parsed.recognized.length ? `本地已识别：${parsed.recognized.join('、')}` : '',
    `仍需解析：${parsed.unresolved.join('、')}`,
  ].filter(Boolean).join('\n')
}

function strategyContext(pending) {
  if (pending?.strategy?.kind === 'Roguelike') return { kind: 'Roguelike', task: { ...pending.strategy.step }, description: '肉鸽策略' }
  if (pending?.strategy?.kind === 'Copilot') return { kind: 'Copilot', task: { stageName: pending.strategy.stageName, formation: pending.strategy.formation }, description: 'Copilot 策略' }
  const tasks = Array.isArray(pending?.document?.tasks) ? pending.document.tasks : []
  const rogue = tasks.find(item => item?.type === 'Roguelike')
  if (rogue) {
    const params = rogue.params ?? {}
    return {
      kind: 'Roguelike', description: '肉鸽任务',
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
  if (fight?.params?.stage) return { kind: 'Copilot', task: { stageName: fight.params.stage, formation: true }, description: `作战 ${fight.params.stage}` }
  return { kind: 'Unsupported', task: {}, description: tasks.map(item => item?.type).filter(Boolean).join(' → ') || '未知任务' }
}

function enabledCombatAtoms(store, stageName) {
  return (store.categories.combat ?? []).filter(entry => entry.enabled !== false && entry.source === 'strategy')
    .map(entry => entry.atom).filter(atom => atom?.operation?.startsWith('tactic_') || (atom?.operation === 'action' && atom?.applicability?.stageName === stageName))
}

function latestTactic(store, kind) {
  return (store.categories.combat ?? []).findLast(entry => entry.enabled !== false && entry.semanticKey === `tactic:${kind}`)?.atom ?? null
}

function cleanText(value) {
  const result = String(value ?? '').replace(/[\r\n\t]+/gu, ' ').trim()
  if (result === '' || result.length > 120) throw new Error('备注必须是 1–120 个字符。')
  return result
}
function cleanClause(value) { return String(value).replace(/^(?:请|麻烦|帮我|要求)\s*/u, '').trim() }
function cleanName(value) { return String(value ?? '').replace(/^[“”"'\s]+|[“”"'\s]+$/gu, '').trim() }
function numberValue(value) { if (value === undefined) return undefined; if (/^\d+$/u.test(value)) return Number(value); return NUMBER_WORDS.get(value) }
