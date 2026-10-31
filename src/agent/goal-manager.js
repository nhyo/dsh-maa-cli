import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'
import { applyDropRates, applyJointPlan, expandSynthesis, mergeRequirements, operatorUpgradeRequirements } from './planning-data.js'

const VERSION = 1
const MAX_GOALS = 30
let mutation = Promise.resolve()

export function goalFilePath(env = process.env) { return path.join(stateDirectory(env), 'goals.json') }

export async function readGoals(options = {}) {
  try {
    const parsed = JSON.parse(await readFile(goalFilePath(options.env ?? process.env), 'utf8'))
    return parsed?.version === VERSION && Array.isArray(parsed.goals) ? parsed.goals : []
  } catch { return [] }
}

export async function createGoal(input, plan, options = {}) {
  const env = options.env ?? process.env
  return await mutate(env, async goals => {
    const now = options.now ?? Date.now()
    const goal = {
      id: `GOAL-${randomBytes(4).toString('hex').toUpperCase()}`,
      title: requiredText(input.title ?? input.purpose, '目标标题', 120),
      kind: String(input.kind ?? 'custom'),
      request: structuredClone(input),
      status: plan.status === 'ready' ? 'pending_confirmation' : 'needs_input',
      constraints: plan.constraints,
      completion: plan.completion,
      facts: plan.facts,
      gaps: plan.gaps,
      workflowExecutionId: '',
      needsUser: plan.needsUser ?? '',
      createdAt: now,
      updatedAt: now,
    }
    goals.unshift(goal)
    goals.splice(MAX_GOALS)
    return goal
  })
}

export async function updateGoal(id, patch, options = {}) {
  const env = options.env ?? process.env
  return await mutate(env, goals => {
    const goal = goals.find(item => item.id === id)
    if (!goal) return null
    Object.assign(goal, patch, { id, updatedAt: options.now ?? Date.now() })
    return goal
  })
}

export async function getGoal(id, options = {}) { return (await readGoals(options)).find(item => item.id === id) ?? null }
export async function listGoals(options = {}) { return await readGoals(options) }

export async function planGoal(input, context = {}) {
  const kind = String(input.kind ?? '')
  const constraints = normalizeConstraints(input.budget)
  if (kind === 'daily') return dailyPlan(constraints)
  if (kind === 'operator_training') return await trainingPlan(input, context, constraints)
  if (kind === 'materials') return materialGoalPlan(input, context, constraints)
  if (kind === 'custom') return customPlan(input, constraints)
  throw new Error(`不支持的目标类型：${kind}`)
}

function materialGoalPlan(input, context, constraints) {
  if (!context.planningData || !context.depot || !Array.isArray(input.requirements) || input.requirements.length === 0) return materialPlan(input, context, constraints)
  const normalized = input.requirements.map(requirement => ({
    ...requirement,
    itemId: String(requirement.itemId ?? context.itemIndex?.byName?.get(String(requirement.name ?? '').trim().toLocaleLowerCase('zh-CN'))?.id ?? ''),
  }))
  const discovered = applyDropRates(normalized, context.planningData, context.depot, context.stages)
  let dynamicRates = false
  const requirements = discovered.map((value, index) => {
    const explicit = normalized[index]
    if (explicit.stage || explicit.runs) return explicit
    if (value.stage) dynamicRates = true
    return value
  }).sort((a, b) => Number(Boolean(b.stage)) - Number(Boolean(a.stage)))
  return materialPlan({ ...input, requirements, dynamicRates }, context, constraints)
}

function dailyPlan(constraints) {
  return {
    status: 'ready', constraints,
    completion: '每个 MAA 任务链均明确报告完成；不等同于游戏内所有日常奖励已达成。',
    facts: ['使用安全默认值：不消耗源石、理智药、加急许可，不自动购买信用商品。'], gaps: [], needsUser: '',
    steps: [
      maa('startup', '启动并进入游戏', { type: 'StartUp', params: { client_type: 'Official', start_game_enabled: true } }),
      maa('infrast', '基建换班', { type: 'Infrast', params: { mode: 0, facility: ['Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Dorm'], drones: '_NotUse', threshold: 0.3, replenish: false, dorm_notstationed_enabled: false, dorm_trust_enabled: false } }),
      maa('mall', '访问好友信用并保留信用商店预算', { type: 'Mall', params: { visit_friends: true, shopping: false, force_shopping_if_credit_full: false, only_buy_discount: false, reserve_max_credit: true, credit_fight: false } }),
      maa('award', '领取日常与周常奖励', { type: 'Award', params: { award: true, mail: false, recruit: false, orundum: false, mining: false, specialaccess: false } }),
    ],
  }
}

// One or more operator goals. Elite/level come from the verified Box; skill,
// mastery and module levels must be supplied (MAA's OperBox has none of them).
export function trainingTargets(input) {
  const list = Array.isArray(input.operators) && input.operators.length > 0 ? input.operators : [input]
  if (list.length > 12) throw new Error('一次最多规划 12 名干员。')
  return list.map((entry, index) => {
    const operator = String(entry?.operator ?? '').trim()
    if (!operator) throw new Error(`干员培养目标 #${index + 1} 必须提供 operator。`)
    return {
      operator, targetElite: entry.targetElite, targetLevel: entry.targetLevel,
      skillLevel: entry.skillLevel, masteries: entry.masteries, modules: entry.modules,
    }
  })
}

// Pure requirement calculation shared by goal planning and read-only estimates.
export function trainingRequirements(input, context) {
  const targets = trainingTargets(input)
  const facts = []
  const lists = []
  for (const target of targets) {
    const owned = context.operatorBox?.operators?.find(item => item.name === target.operator)
    if (!owned) return { needsUser: `Box 缓存中没有已拥有干员“${target.operator}”。请确认干员名称或先重新扫描 Box。`, facts }
    facts.push(`${target.operator} 当前精${owned.elite} ${owned.level}级，潜能${owned.potential}。`)
    let calculated
    try {
      calculated = operatorUpgradeRequirements(context.planningData, { ...target, current: owned, depot: context.depot })
    } catch (error) {
      if (error?.code === 'MAA_NEEDS_INPUT') return { needsUser: error.message, facts }
      throw error
    }
    facts.push(`${target.operator} 培养目标：${calculated.breakdown.join('、') || '无变化'}；需 ${calculated.totalExp} 经验、${calculated.totalLmd} 龙门币（不含加工站）。`)
    lists.push(calculated.requirements)
  }
  let requirements = mergeRequirements(lists)
  let syntheses = []
  if (input.expandSynthesis === true) {
    const expanded = expandSynthesis(requirements, context.planningData, context.depot)
    requirements = expanded.requirements
    syntheses = expanded.syntheses
    if (syntheses.length) facts.push(`按加工站配方展开 ${syntheses.length} 种高阶材料（加工站另需 ${expanded.workshopLmd} 龙门币）；展开前已扣除库存。`)
  }
  return { requirements, syntheses, facts, targets }
}

async function trainingPlan(input, context, constraints) {
  const targets = trainingTargets(input)
  const names = targets.map(target => target.operator).join('、')
  const steps = []
  const facts = []
  if (!context.operatorBox) {
    steps.push(maa('scan-box', '读取干员 Box', { type: 'OperBox', params: {} }))
    if (!context.depot) steps.push(maa('scan-depot', '读取仓库库存', { type: 'Depot', params: {} }))
    steps.push(decision('replan-after-state-scan', `完成状态扫描后重新规划 ${names} 的培养；在确认新计划前不会刷图或消耗资源。`))
    return {
      status: 'ready', constraints,
      completion: `取得可靠的 Box 与 Depot 缓存后重新规划 ${names} 的培养。`,
      facts: ['当前没有可用的干员 Box 缓存，未假定干员已拥有或当前等级。'], gaps: [], steps, needsUser: '',
    }
  }
  let planningInput = input
  if (!Array.isArray(input.requirements) || input.requirements.length === 0) {
    if (!context.planningData) {
      return needsInput(constraints, facts, `无法自动取得可靠培养需求：${context.planningDataError || '培养数据不可用'}。可稍后重试，或明确提供材料需求。`)
    }
    const calculated = trainingRequirements(input, context)
    facts.push(...calculated.facts)
    if (calculated.needsUser) return needsInput(constraints, facts, calculated.needsUser)
    let requirements = null
    if (typeof context.jointPlanner === 'function' && context.depot) {
      const joint = await context.jointPlanner(calculated.requirements)
      if (joint?.source === 'arkplanner' && joint.stages.length > 0) {
        requirements = applyJointPlan(calculated.requirements, joint, context.depot)
        facts.push(`企鹅物流 ArkPlanner 联合规划：${joint.stages.slice(0, 6).map(stage => `${stage.stage}×${stage.count}`).join('、')}，预计共 ${joint.cost} 理智（统计期望）。`)
      } else if (joint) {
        facts.push(`ArkPlanner 暂不可用（${joint.error || '未返回关卡'}），已按单材料最低期望理智选关，未联合优化。`)
      }
    }
    if (!requirements) {
      requirements = applyDropRates(calculated.requirements, context.planningData, context.depot, context.stages)
    }
    requirements.sort((a, b) => Number(Boolean(b.stage)) - Number(Boolean(a.stage)))
    planningInput = { ...input, requirements, dynamicRates: true }
    facts.push(`培养数据更新时间：${context.planningData.updatedAt}（${context.planningData.server}）；掉率为企鹅物流统计值，执行后必须重扫仓库。`)
    if (context.planningData.stale || context.planningData.warning) facts.push(context.planningData.warning)
  } else {
    for (const target of targets) {
      const owned = context.operatorBox.operators.find(item => item.name === target.operator)
      if (!owned) return needsInput(constraints, [`Box 缓存中没有已拥有干员“${target.operator}”。`], '请确认干员名称或先重新扫描 Box。')
      facts.push(`${target.operator} 当前精${owned.elite} ${owned.level}级，潜能${owned.potential}。`)
    }
  }
  const material = materialPlan(planningInput, context, constraints, steps, facts)
  material.completion = `材料缺口归零并由用户在游戏内完成 ${names} 的升级/精英化/技能/模组；MAA 当前没有通用干员升级任务，插件不会把收集材料误报为培养完成。`
  if (material.steps.length === 0 && material.status === 'ready') material.steps.push(decision('manual-upgrade', `材料状态已满足已提供的需求；请在游戏内手动完成 ${names} 的培养后确认。`))
  return material
}

function materialPlan(input, context, constraints, initialSteps = [], initialFacts = []) {
  const requirements = Array.isArray(input.requirements) ? input.requirements : []
  const steps = [...initialSteps]
  const facts = [...initialFacts]
  if (!context.depot) {
    steps.push(maa('scan-depot', '读取仓库库存', { type: 'Depot', params: {} }))
    steps.push(decision('replan-after-depot', '仓库扫描完成后需要按新缓存重新计算材料缺口；在确认新计划前不会开始刷图。'))
    return { status: 'ready', constraints, completion: '取得可靠的 Depot 缓存后重新规划。', facts: [...facts, '当前没有可用的仓库缓存，未把未知库存当作 0。'], gaps: [], steps, needsUser: '' }
  }
  if (requirements.length === 0) {
    return needsInput(constraints, facts, 'MAA 资源不包含干员升级材料需求表。请提供目标材料及数量。')
  }
  const resolved = requirements.map(requirement => resolveRequirement(requirement, context.itemIndex, context.depot))
  const gaps = resolved.filter(item => item.gap > 0)
  let plannedSanity = 0
  let medicineRemaining = constraints.maxMedicine
  let expiringMedicineRemaining = constraints.maxExpiringMedicine
  let scheduledDynamicFight = false
  facts.push(...resolved.map(item => `${item.name || item.itemId}：需要 ${item.required}，库存 ${item.owned}，缺口 ${item.gap}。${item.drop ? ` 建议 ${item.stage}，统计 ${item.drop.samples} 次、均值 ${item.drop.rate.toFixed(4)}/局。` : ''}`))
  for (const gap of gaps) {
    if (gap.stage && gap.runs) {
      const stage = context.stages?.find(item => item.code === gap.stage)
      if (!stage) {
        steps.push(decision(`validate-stage-${gap.itemId}`, `当前 MAA stages.json 中找不到关卡 ${gap.stage}，已阻止执行；请刷新资源或重新选择关卡。`))
        continue
      }
      if (!stage.dropInfos?.some(drop => drop.itemId === gap.itemId && ['NORMAL_DROP', 'EXTRA_DROP'].includes(drop.dropType))) {
        steps.push(decision(`validate-drop-${gap.itemId}`, `MAA stages.json 未显示 ${gap.stage} 会掉落 ${gap.name || gap.itemId}，已阻止执行；请重新选择关卡。`))
        continue
      }
      const sanityCost = Math.max(0, Number(stage.apCost) || 0) * gap.runs
      if (constraints.maxSanity !== null && plannedSanity + sanityCost > constraints.maxSanity) {
        steps.push(decision(`budget-${gap.itemId}`, `${gap.stage} × ${gap.runs} 会使计划累计理智达到 ${plannedSanity + sanityCost}，超过预算 ${constraints.maxSanity}；已阻止执行。`))
        continue
      }
      steps.push(maa(`farm-${gap.itemId}`, `刷取 ${gap.name || gap.itemId}`, {
        type: 'Fight', params: { stage: gap.stage, times: gap.runs, medicine: medicineRemaining, expiring_medicine: expiringMedicineRemaining, stone: 0, series: gap.runs <= 10 ? gap.runs : 0 },
      }))
      plannedSanity += sanityCost
      medicineRemaining = 0
      expiringMedicineRemaining = 0
      if (input.dynamicRates === true) { scheduledDynamicFight = true; break }
    } else {
      const candidates = stageCandidates(gap.itemId, context.stages)
      gap.stageCandidates = candidates
      steps.push(decision(`choose-${gap.itemId}`, candidates.length
        ? `${gap.name || gap.itemId} 缺少 ${gap.gap}。MAA 仅提供掉落关卡、不提供掉率；候选：${candidates.map(item => `${item.code}(${item.apCost}理智)`).join('、')}。请指定关卡和次数。`
        : `${gap.name || gap.itemId} 缺少 ${gap.gap}，当前 MAA stages.json 没有可靠的常驻普通掉落关卡，请人工决定来源。`))
    }
  }
  if (gaps.length === 0 && context.depot) {
    facts.push('已提供的材料需求均由当前仓库满足。')
    return needsInput(constraints, facts, '当前 Depot 缓存显示材料需求已满足，无需启动消耗性任务；如需培养干员，请在游戏内完成升级。')
  }
  if (!steps.some(step => step.kind === 'maa')) {
    return needsInput(constraints, facts, steps.map(step => step.prompt).filter(Boolean).join('；'))
  }
  if (scheduledDynamicFight) {
    steps.push(maa('verify-depot', '重新扫描仓库验证实际掉落', { type: 'Depot', params: {} }))
    steps.push(decision('replan-after-farm', '掉率是统计期望，不保证单次结果。仓库重扫完成后请重新规划剩余缺口；确认新计划前不会继续消耗理智。'))
  }
  return { status: 'ready', constraints, completion: '重新扫描 Depot 后，所有已提供材料需求的库存均达到要求。', facts, gaps, steps, needsUser: '' }
}

function customPlan(input, constraints) {
  if (!Array.isArray(input.steps) || input.steps.length === 0) return needsInput(constraints, [], '自定义目标必须提供至少一个可执行步骤。')
  return { status: 'ready', constraints, completion: String(input.completion ?? '所有步骤均由 MAA 明确报告完成。'), facts: [], gaps: [], steps: input.steps, needsUser: '' }
}

function resolveRequirement(requirement, index, depot) {
  const itemId = String(requirement.itemId ?? index?.byName?.get(String(requirement.name ?? '').trim().toLocaleLowerCase('zh-CN'))?.id ?? '')
  if (!itemId || !index?.byId?.has(itemId)) throw new Error(`MAA 物品索引中找不到材料：${requirement.name || requirement.itemId || '未命名'}`)
  const metadata = index.byId.get(itemId)
  const required = integer(requirement.quantity, 1, 2_147_483_647, `${metadata.name}.quantity`)
  const owned = depot?.items?.[itemId] ?? 0
  return { itemId, name: metadata.name, required, owned, gap: Math.max(0, required - owned), stage: String(requirement.stage ?? ''), runs: requirement.runs === undefined || requirement.runs === 0 ? 0 : integer(requirement.runs, 1, 100, `${metadata.name}.runs`), drop: requirement.drop ?? null }
}

function stageCandidates(itemId, stages) {
  if (!Array.isArray(stages)) return []
  return stages.filter(stage => /^\d+-\d+$/u.test(stage.code) && stage.dropInfos?.some(drop => drop.itemId === itemId && drop.dropType === 'NORMAL_DROP'))
    .map(stage => ({ code: stage.code, apCost: Number(stage.apCost) || 0 })).sort((a, b) => a.apCost - b.apCost || a.code.localeCompare(b.code)).slice(0, 5)
}

function normalizeConstraints(budget = {}) {
  return { allowStone: budget?.allowStone === true, maxMedicine: integer(budget?.maxMedicine ?? 0, 0, 999, 'maxMedicine'), maxExpiringMedicine: integer(budget?.maxExpiringMedicine ?? 0, 0, 999, 'maxExpiringMedicine'), maxSanity: budget?.maxSanity == null ? null : integer(budget.maxSanity, 0, 100000, 'maxSanity') }
}

function maa(id, title, task) { return { id, kind: 'maa', title, maa: task, completion: 'maa_verified' } }
function decision(id, prompt) { return { id, kind: 'decision', title: '需要人工决策', prompt } }
function needsInput(constraints, facts, needsUser) { return { status: 'needs_input', constraints, completion: '', facts, gaps: [], steps: [], needsUser } }
function requiredText(value, label, max) { const text = String(value ?? '').trim(); if (!text || text.length > max) throw new Error(`${label} 长度必须是 1–${max}。`); return text }
function integer(value, min, max, label) { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min}–${max} 的整数。`); return value }

async function mutate(env, updater) {
  const operation = mutation.then(async () => {
    const goals = await readGoals({ env })
    const result = await updater(goals)
    const file = goalFilePath(env)
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    const payload = `${JSON.stringify({ version: VERSION, goals }, null, 2)}\n`
    try { await writeFile(temporary, payload, 'utf8'); await rename(temporary, file) }
    catch { await writeFile(file, payload, 'utf8'); await rm(temporary, { force: true }).catch(() => {}) }
    return result
  })
  mutation = operation.catch(() => {})
  return operation
}
