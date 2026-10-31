import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory, writeJsonAtomically } from '../runtime/state.js'
import { fetchJson } from './http.js'

// v2 added skill/mastery/module costs, workshop formulas and weekly stage
// schedules; v3 takes stage zones from the game's own stage_table (Penguin
// files every chip stage under one zone). Older caches are downloaded again.
const VERSION = 3
const UPDATE_INTERVAL_MS = 24 * 60 * 60_000
const SERVER_DIRECTORY = { CN: 'cn', US: 'en', JP: 'jp', KR: 'kr' }
// Daily reset happens at 04:00 server time.
const SERVER_UTC_OFFSET_HOURS = { CN: 8, US: -7, JP: 9, KR: 9 }
const BASE = 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master'
const MATRIX = 'https://penguin-stats.io/PenguinStats/api/v2/result/matrix'
// MAA's stages.json has stageId/code but no zoneId, so the weekly zone of each
// stage comes from the game's stage_table.json (about 26 MB, hence its own cap).
const STAGE_TABLE_MAX_BYTES = 96 * 1024 * 1024
const ARKPLANNER = 'https://planner.penguin-stats.io/plan'
const RECORD_EXP = { 2001: 200, 2002: 400, 2003: 1000, 2004: 2000 }
const LMD = '4001'
let update = Promise.resolve()

export function planningDataFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'planning-data.json')
}

export async function loadPlanningData(options = {}) {
  const env = options.env ?? process.env
  const server = normalizeServer(options.server)
  const now = options.now ?? Date.now()
  const cached = await readPlanningData({ env })
  if (!options.force && cached?.server === server && now - Date.parse(cached.updatedAt) < (options.maxAgeMs ?? UPDATE_INTERVAL_MS)) return cached
  const operation = update.then(() => refreshPlanningData({ ...options, env, server, now, previous: cached }))
  update = operation.catch(() => {})
  return await operation
}

export async function readPlanningData(options = {}) {
  try { return validateCache(JSON.parse(await readFile(planningDataFilePath(options.env ?? process.env), 'utf8'))) } catch { return null }
}

export async function refreshPlanningData(options = {}) {
  const env = options.env ?? process.env
  const server = normalizeServer(options.server)
  const now = options.now ?? Date.now()
  const previous = options.previous ?? await readPlanningData({ env })
  const directory = SERVER_DIRECTORY[server]
  const excel = `${BASE}/${directory}/gamedata/excel`
  const urls = {
    characters: `${excel}/character_table.json`,
    constants: `${excel}/gamedata_const.json`,
    matrix: `${MATRIX}?server=${server}&show_closed_zones=false`,
    zones: `${excel}/zone_table.json`,
    modules: `${excel}/uniequip_table.json`,
    building: `${excel}/building_data.json`,
    stageZones: `${excel}/stage_table.json`,
    ...(options.urls ?? {}),
  }
  try {
    // Core sources are required; without them no requirement can be trusted.
    const [charactersResult, constantsResult, matrixResult] = await Promise.all([
      fetchJson(urls.characters, options), fetchJson(urls.constants, options), fetchJson(urls.matrix, options),
    ])
    const operators = compactOperators(charactersResult.data)
    const leveling = compactLeveling(constantsResult.data)
    const matrix = compactMatrix(matrixResult.data)
    // Optional sources add features. A failure disables only that feature and
    // keeps the previous verified copy of it when one exists.
    const optional = await Promise.all([
      optionalSource(urls.zones, options, compactWeeklyZones),
      optionalSource(urls.modules, options, compactModules),
      optionalSource(urls.building, options, compactFormulas),
      optionalSource(urls.stageZones, { ...options, maxBytes: STAGE_TABLE_MAX_BYTES }, compactStageZones),
    ])
    const sameServer = previous?.server === server ? previous : null
    const keys = ['weekly', 'modules', 'formulas', 'stageZones']
    const previousValue = key => key === 'stageZones' ? sameServer?.weekly?.stageZones ?? null : sameServer?.[key] ?? null
    const [weeklyZones, modules, formulas, stageZones] = optional.map((entry, index) => entry.value ?? previousValue(keys[index]))
    const weekly = weeklyZones ? { zones: weeklyZones.zones, stageZones: stageZones ?? {} } : null
    const warnings = optional.map((entry, index) => entry.error ? `${['关卡开放日', '模组消耗', '加工站配方', '关卡分区'][index]}数据更新失败：${entry.error}${previousValue(keys[index]) ? '（沿用上次缓存）' : '（该功能暂不可用）'}` : '').filter(Boolean)
    const cache = validateCache({
      version: VERSION, server, updatedAt: new Date(now).toISOString(), stale: false, warning: warnings.join('；'),
      operators, leveling, matrix, weekly, modules, formulas,
      sources: {
        gamedata: sourceMetadata([charactersResult, constantsResult, ...optional.map(entry => entry.result).filter(Boolean)], now),
        penguin: sourceMetadata([matrixResult], now),
      },
    })
    await writeCache(cache, env)
    return cache
  } catch (error) {
    if (previous?.server === server) return { ...previous, stale: true, warning: `培养/掉率数据更新失败，沿用上次已验证缓存：${message(error)}` }
    throw new Error(`无法取得可靠的培养/掉率数据：${message(error)}`)
  }
}

// Requirements for one operator goal. Elite/level come from the verified Box;
// skill, mastery and module levels are not part of MAA's OperBox output, so
// their current values must be supplied by the caller and are never assumed.
export function operatorUpgradeRequirements(data, input) {
  const cache = validateCache(data)
  const current = input.current
  const operator = cache.operators.find(item => item.id === current?.id)
    ?? cache.operators.find(item => item.name === input.operator)
  if (!operator) throw new Error(`培养数据中找不到干员“${input.operator}”。`)
  const currentElite = integer(current?.elite, 0, 2, 'current.elite')
  const currentLevel = integer(current?.level, 1, operator.phases[currentElite]?.maxLevel ?? 90, 'current.level')
  const wantsPromotion = input.targetElite !== undefined || input.targetLevel !== undefined || !hasSkillGoals(input)
  const targetElite = wantsPromotion ? integer(input.targetElite ?? 2, currentElite, Math.min(2, operator.phases.length - 1), 'targetElite') : currentElite
  const targetMax = operator.phases[targetElite]?.maxLevel
  const targetLevel = wantsPromotion ? integer(input.targetLevel ?? (targetElite === currentElite ? currentLevel : 1), 1, targetMax, 'targetLevel') : currentLevel
  if (targetElite === currentElite && targetLevel < currentLevel) throw new Error('培养目标不能低于干员当前等级。')

  const material = new Map()
  const breakdown = []
  let exp = 0
  let lmd = 0
  let elite = currentElite
  let level = currentLevel
  while (elite < targetElite) {
    const maxLevel = operator.phases[elite].maxLevel
    const levelCost = sumLeveling(cache.leveling, elite, level, maxLevel)
    exp += levelCost.exp; lmd += levelCost.lmd
    for (const cost of operator.phases[elite + 1].evolveCost) add(material, cost.id, cost.count)
    const promotion = cache.leveling.evolveGoldCost[operator.rarity - 1]?.[elite]
    if (Number.isInteger(promotion) && promotion > 0) lmd += promotion
    elite += 1; level = 1
  }
  const finalLevel = sumLeveling(cache.leveling, elite, level, targetLevel)
  exp += finalLevel.exp; lmd += finalLevel.lmd
  if (wantsPromotion) breakdown.push(`精${currentElite} ${currentLevel}级 → 精${targetElite} ${targetLevel}级`)

  const finalElite = Math.max(currentElite, targetElite)
  if (input.skillLevel?.target !== undefined) {
    const target = integer(input.skillLevel.target, 1, 7, 'skillLevel.target')
    if (input.skillLevel.current === undefined) throw needsInput(`${operator.name} 当前技能等级未知（Box 扫描不含技能等级），请告诉我当前是几级。`)
    const from = integer(input.skillLevel.current, 1, 7, 'skillLevel.current')
    if (target > 4 && finalElite < 1) throw new Error('技能等级 5–7 需要干员至少精英一。')
    for (let step = from; step < target; step += 1) {
      const costs = operator.skillLevels?.[step - 1]
      if (!Array.isArray(costs)) throw new Error(`培养数据缺少 ${operator.name} 技能 ${step}→${step + 1} 的消耗。`)
      for (const cost of costs) add(material, cost.id, cost.count)
    }
    if (target > from) breakdown.push(`技能 ${from} → ${target} 级`)
  }
  for (const [index, goal] of (Array.isArray(input.masteries) ? input.masteries : []).entries()) {
    const skill = integer(goal?.skill, 1, 3, `masteries[${index}].skill`)
    const target = integer(goal?.target, 1, 3, `masteries[${index}].target`)
    const costs = operator.masteries?.[skill - 1]
    if (!Array.isArray(costs)) throw new Error(`${operator.name} 没有第 ${skill} 个技能，或培养数据缺少其专精消耗。`)
    if (goal.current === undefined) throw needsInput(`${operator.name} ${skill} 技能当前专精等级未知（Box 扫描不含专精），请告诉我当前是专精几（未专精为 0）。`)
    const from = integer(goal.current, 0, 3, `masteries[${index}].current`)
    if (finalElite < 2) throw new Error(`${operator.name} 需要精英二才能专精，请同时把 targetElite 设为 2。`)
    for (let step = from; step < target; step += 1) for (const cost of costs[step] ?? []) add(material, cost.id, cost.count)
    if (target > from) breakdown.push(`${skill} 技能专精 ${from} → ${target}`)
  }
  for (const [index, goal] of (Array.isArray(input.modules) ? input.modules : []).entries()) {
    const target = integer(goal?.target, 1, 3, `modules[${index}].target`)
    const module = findModule(cache, operator, goal)
    if (goal.current === undefined) throw needsInput(`${operator.name} ${module.type || module.name} 模组当前等级未知（Box 扫描不含模组），请告诉我当前等级（未解锁为 0）。`)
    const from = integer(goal.current, 0, 3, `modules[${index}].current`)
    if (finalElite < 2) throw new Error(`${operator.name} 需要精英二才能解锁模组，请同时把 targetElite 设为 2。`)
    for (let step = from; step < target; step += 1) for (const cost of module.costs[step] ?? []) add(material, cost.id, cost.count)
    if (target > from) breakdown.push(`${module.type || module.name} 模组 ${from} → ${target} 级`)
  }

  if (lmd > 0) add(material, LMD, lmd)
  const depot = input.depot?.items ?? {}
  const lowerRecordExp = ['2001', '2002', '2003'].reduce((total, id) => total + (Number(depot[id]) || 0) * RECORD_EXP[id], 0)
  const advancedRecords = Math.ceil(Math.max(0, exp - lowerRecordExp) / RECORD_EXP['2004'])
  if (advancedRecords > 0) add(material, '2004', advancedRecords)

  const requirements = [...material.entries()].map(([itemId, quantity]) => ({ itemId, quantity }))
  return {
    operatorId: operator.id, operator: operator.name,
    current: { elite: currentElite, level: currentLevel }, target: { elite: targetElite, level: targetLevel },
    totalExp: exp, totalLmd: lmd, requirements, breakdown,
    source: cache.sources.gamedata,
  }
}

// Sum several requirement lists item by item.
export function mergeRequirements(lists) {
  const total = new Map()
  for (const list of lists) for (const item of list ?? []) add(total, item.itemId, item.quantity)
  return [...total.entries()].map(([itemId, quantity]) => ({ itemId, quantity }))
}

// Expand higher-tier materials into their workshop ingredients after deducting
// stock. Only material processing formulas (F_EVOLVE) are used; LMD for the
// workshop is added to the result.
export function expandSynthesis(requirements, data, depot) {
  const cache = validateCache(data)
  if (!Array.isArray(cache.formulas)) throw new Error('培养数据中没有加工站配方，无法展开合成。')
  const formulas = new Map(cache.formulas.map(formula => [formula.itemId, formula]))
  const stock = new Map(Object.entries(depot?.items ?? {}).map(([id, count]) => [id, Number(count) || 0]))
  const need = new Map()
  for (const item of requirements) add(need, item.itemId, item.quantity)
  const depthCache = new Map()
  const depth = (id, seen = new Set()) => {
    if (depthCache.has(id)) return depthCache.get(id)
    const formula = formulas.get(id)
    if (!formula || seen.has(id)) return 0
    seen.add(id)
    const value = 1 + Math.max(0, ...formula.costs.map(cost => depth(cost.id, seen)))
    depthCache.set(id, value)
    return value
  }
  const syntheses = []
  let lmd = 0
  // Highest tier first so each ingredient is expanded after all its consumers.
  for (let guard = 0; guard < 200; guard += 1) {
    const pending = [...need.entries()].filter(([id, count]) => count > (stock.get(id) ?? 0) && formulas.has(id))
      .sort((a, b) => depth(b[0]) - depth(a[0]))
    if (pending.length === 0) break
    const [id, count] = pending[0]
    const formula = formulas.get(id)
    const gap = count - (stock.get(id) ?? 0)
    const crafts = Math.ceil(gap / formula.count)
    need.set(id, stock.get(id) ?? 0)
    for (const cost of formula.costs) add(need, cost.id, cost.count * crafts)
    lmd += formula.goldCost * crafts
    syntheses.push({ itemId: id, crafts, produces: crafts * formula.count, costs: formula.costs.map(cost => ({ itemId: cost.id, quantity: cost.count * crafts })) })
  }
  if (lmd > 0) add(need, LMD, lmd)
  return {
    requirements: [...need.entries()].filter(([, quantity]) => quantity > 0).map(([itemId, quantity]) => ({ itemId, quantity })),
    syntheses, workshopLmd: lmd,
  }
}

// Weekly resource/chip stage schedule for "today" in the game's server time
// (the day starts at 04:00). Stages come from MAA's stages.json so only stages
// the installed MAA knows are reported.
export function weeklyStageSchedule(data, stages, options = {}) {
  const cache = validateCache(data)
  if (!cache.weekly?.zones) throw new Error('培养数据中没有关卡开放日信息，请稍后刷新数据。')
  const server = normalizeServer(options.server ?? cache.server)
  const day = serverWeekday(options.now ?? Date.now(), server)
  const byZone = new Map()
  for (const stage of Array.isArray(stages) ? stages : []) {
    const zoneId = typeof stage?.zoneId === 'string' ? stage.zoneId : cache.weekly.stageZones?.[stage?.stageId]
    if (typeof zoneId !== 'string' || !cache.weekly.zones[zoneId]) continue
    if (!byZone.has(zoneId)) byZone.set(zoneId, [])
    byZone.get(zoneId).push(String(stage.code))
  }
  const zones = Object.entries(cache.weekly.zones).map(([zoneId, zone]) => ({
    zoneId, name: zone.name, kind: zone.kind,
    daysOfWeek: zone.daysOfWeek,
    openToday: Array.isArray(zone.daysOfWeek) ? zone.daysOfWeek.includes(day) : null,
    stages: (byZone.get(zoneId) ?? []).sort(),
  })).filter(zone => zone.stages.length > 0)
  return { server, weekday: day, zones }
}

// Is a single stage code open today? Returns null when it is not a weekly
// stage or the schedule is unknown.
export function weeklyStageOpen(data, stages, code, options = {}) {
  try {
    const schedule = weeklyStageSchedule(data, stages, options)
    const zone = schedule.zones.find(item => item.stages.includes(code))
    return zone ? { ...zone, weekday: schedule.weekday } : null
  } catch { return null }
}

export function serverWeekday(now, server = 'CN') {
  const offset = SERVER_UTC_OFFSET_HOURS[normalizeServer(server)] - 4
  const shifted = new Date(now + offset * 60 * 60_000)
  const day = shifted.getUTCDay()
  return day === 0 ? 7 : day
}

// Joint multi-material plan from Penguin Statistics' ArkPlanner. Returns null
// when the planner cannot be reached so callers fall back to applyDropRates.
export async function planWithArkPlanner(input, options = {}) {
  const index = input.itemIndex
  if (!index?.byId) throw new Error('缺少 MAA 物品索引，无法调用 ArkPlanner。')
  const nameOf = id => index.byId.get(String(id))?.name ?? ''
  const required = {}
  for (const item of input.requirements ?? []) {
    if (item.itemId === LMD || String(item.itemId).startsWith('200')) continue
    const name = nameOf(item.itemId)
    if (name) required[name] = (required[name] ?? 0) + item.quantity
  }
  if (Object.keys(required).length === 0) return { stages: [], syntheses: [], cost: 0, source: 'arkplanner' }
  const owned = {}
  for (const [id, count] of Object.entries(input.depot?.items ?? {})) {
    const name = nameOf(id)
    if (name && Number(count) > 0) owned[name] = Number(count)
  }
  try {
    const result = await fetchJson(options.url ?? ARKPLANNER, {
      ...options, method: 'POST', timeoutMs: options.timeoutMs ?? 20_000,
      body: { owned, required, extra_outc: false, exp_demand: false, gold_demand: false, store: false, input_lang: 'zh', output_lang: 'id', server: normalizeServer(input.server), exclude: input.exclude ?? [] },
    })
    const data = result.data
    if (!data || !Array.isArray(data.stages)) throw new Error('ArkPlanner 返回格式无效。')
    return {
      source: 'arkplanner', cost: Number(data.cost) || 0,
      stages: data.stages.map(stage => ({
        stage: String(stage.stage ?? ''), count: Math.ceil(Number(stage.count) || 0),
        items: Object.fromEntries(Object.entries(stage.items ?? {}).map(([id, value]) => [String(id), Number(value) || 0])),
      })).filter(stage => stage.stage && stage.count > 0),
      syntheses: Array.isArray(data.syntheses) ? data.syntheses.map(entry => ({ target: String(entry.target ?? ''), count: Math.ceil(Number(entry.count) || 0) })) : [],
    }
  } catch (error) {
    return { source: 'unavailable', error: message(error), stages: [], syntheses: [], cost: 0 }
  }
}

// Assign each requirement the ArkPlanner stage that yields the most of it.
export function applyJointPlan(requirements, plan, depot) {
  return requirements.map(requirement => {
    const owned = Number(depot?.items?.[requirement.itemId]) || 0
    const gap = Math.max(0, requirement.quantity - owned)
    if (gap === 0) return { ...requirement, gap, stage: '', runs: 0, drop: null }
    const best = (plan?.stages ?? []).map(stage => ({ stage, expected: stage.items[requirement.itemId] ?? 0 }))
      .filter(entry => entry.expected > 0).sort((a, b) => b.expected - a.expected)[0]
    if (!best) return { ...requirement, gap, stage: '', runs: 0, drop: null }
    return { ...requirement, gap, stage: best.stage.stage, runs: Math.min(100, best.stage.count), drop: { source: 'arkplanner', expected: best.expected, plannedRuns: best.stage.count } }
  })
}

export function rankDropStages(data, itemId, stages, options = {}) {
  const cache = validateCache(data)
  const minimumSamples = options.minimumSamples ?? 100
  const now = options.now ?? Date.now()
  const byId = new Map((Array.isArray(stages) ? stages : []).map(stage => [stage.stageId, stage]))
  return cache.matrix.filter(row => row.itemId === String(itemId) && row.times >= minimumSamples && (row.end === null || row.end > now))
    .map(row => {
      const stage = byId.get(row.stageId)
      if (!stage || !Number.isFinite(Number(stage.apCost)) || Number(stage.apCost) <= 0 || row.quantity <= 0) return null
      const rate = row.quantity / row.times
      return { stage: stage.code, stageId: row.stageId, apCost: Number(stage.apCost), rate, samples: row.times, sanityPerItem: Number(stage.apCost) / rate, start: row.start, end: row.end }
    }).filter(Boolean)
    .sort((a, b) => a.sanityPerItem - b.sanityPerItem || b.samples - a.samples)
}

export function applyDropRates(requirements, data, depot, stages, options = {}) {
  return requirements.map(requirement => {
    const owned = Number(depot?.items?.[requirement.itemId]) || 0
    const gap = Math.max(0, requirement.quantity - owned)
    if (gap === 0) return { ...requirement, gap, stage: '', runs: 0, drop: null }
    const best = rankDropStages(data, requirement.itemId, stages, options)[0]
    if (!best) return { ...requirement, gap, stage: '', runs: 0, drop: null }
    return { ...requirement, gap, stage: best.stage, runs: Math.ceil(gap / best.rate), drop: best }
  })
}

async function optionalSource(url, options, compact) {
  if (!url) return { value: null, result: null, error: '未配置数据源' }
  try {
    const result = await fetchJson(url, options)
    return { value: compact(result.data), result, error: '' }
  } catch (error) {
    return { value: null, result: null, error: message(error) }
  }
}

function compactOperators(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('character_table.json 格式无效。')
  const operators = []
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value.name !== 'string' || !Array.isArray(value.phases) || value.phases.length === 0) continue
    const rarity = Number(String(value.rarity ?? '').match(/\d+/u)?.[0])
    if (!Number.isInteger(rarity) || rarity < 1 || rarity > 6) continue
    const phases = value.phases.map(phase => ({
      maxLevel: Number(phase?.maxLevel) || 1,
      evolveCost: costs(phase?.evolveCost),
    }))
    const entry = { id, name: value.name.trim(), rarity, phases }
    if (Array.isArray(value.allSkillLvlup) && value.allSkillLvlup.length > 0) entry.skillLevels = value.allSkillLvlup.map(step => costs(step?.lvlUpCost))
    if (Array.isArray(value.skills) && value.skills.length > 0) entry.masteries = value.skills.map(skill => (Array.isArray(skill?.levelUpCostCond) ? skill.levelUpCostCond : []).map(step => costs(step?.levelUpCost)))
    operators.push(entry)
  }
  if (operators.length < 100) throw new Error('character_table.json 中可用干员数量异常。')
  return operators
}

function compactLeveling(raw) {
  const characterExpMap = raw?.characterExpMap
  const characterUpgradeCostMap = raw?.characterUpgradeCostMap
  const evolveGoldCost = raw?.evolveGoldCost
  if (![characterExpMap, characterUpgradeCostMap, evolveGoldCost].every(Array.isArray)) throw new Error('gamedata_const.json 缺少培养常量。')
  return { characterExpMap, characterUpgradeCostMap, evolveGoldCost }
}

function compactMatrix(raw) {
  const rows = Array.isArray(raw?.matrix) ? raw.matrix : null
  if (!rows) throw new Error('企鹅物流 Matrix 格式无效。')
  return rows.filter(row => typeof row?.stageId === 'string' && typeof row?.itemId === 'string' && Number.isFinite(row.quantity) && Number.isFinite(row.times))
    .map(row => ({ stageId: row.stageId, itemId: row.itemId, quantity: row.quantity, times: row.times, start: Number(row.start) || 0, end: row.end == null ? null : Number(row.end) }))
}

function compactWeeklyZones(raw) {
  const zones = raw?.zones
  if (!zones || typeof zones !== 'object') throw new Error('zone_table.json 格式无效。')
  // The game table calls it weeklyAdditionInfo: { weekly_1: { daysOfWeek: [1, 4, 5, 7], type: 'EVOLVE' } }.
  const source = raw.weeklyAdditionInfo ?? raw.weeklyAdditionInfos
  const additions = source && typeof source === 'object' ? source : {}
  const result = {}
  for (const [zoneId, zone] of Object.entries(zones)) {
    if (zone?.type !== 'WEEKLY') continue
    const info = additions[zoneId]
    const days = Array.isArray(info?.daysOfWeek) ? info.daysOfWeek.map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7) : null
    result[zoneId] = {
      name: String(zone.zoneNameSecond ?? zone.zoneNameFirst ?? zoneId),
      kind: info?.type === 'EVOLVE' ? 'chip' : info?.type ? 'resource' : 'unknown',
      daysOfWeek: days && days.length ? days : null,
    }
  }
  if (Object.keys(result).length === 0) throw new Error('zone_table.json 中没有周常关卡区。')
  if (Object.values(result).every(zone => zone.daysOfWeek === null)) throw new Error('zone_table.json 中没有周常开放日（weeklyAdditionInfo）。')
  return { zones: result }
}

function compactStageZones(raw) {
  const stages = raw?.stages
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) throw new Error('stage_table.json 格式无效。')
  const result = {}
  for (const [stageId, stage] of Object.entries(stages)) {
    if (typeof stage?.zoneId === 'string' && stage.zoneId.startsWith('weekly')) result[stageId] = stage.zoneId
  }
  if (Object.keys(result).length === 0) throw new Error('stage_table.json 中没有周常关卡。')
  return result
}

function compactModules(raw) {
  const dict = raw?.equipDict
  if (!dict || typeof dict !== 'object') throw new Error('uniequip_table.json 格式无效。')
  const modules = []
  for (const [id, entry] of Object.entries(dict)) {
    const itemCost = entry?.itemCost
    if (!entry?.charId || !itemCost || typeof itemCost !== 'object') continue
    const stages = [1, 2, 3].map(level => costs(itemCost[String(level)]))
    if (stages.every(stage => stage.length === 0)) continue
    modules.push({
      id, operatorId: String(entry.charId), name: String(entry.uniEquipName ?? id),
      type: String(entry.typeName2 ?? entry.typeName1 ?? '').trim(), costs: stages,
    })
  }
  return modules
}

function compactFormulas(raw) {
  const workshop = raw?.workshopFormulas
  if (!workshop || typeof workshop !== 'object') throw new Error('building_data.json 缺少加工站配方。')
  const formulas = []
  for (const entry of Object.values(workshop)) {
    if (entry?.formulaType !== 'F_EVOLVE' || typeof entry.itemId !== 'string') continue
    const list = costs(entry.costs)
    if (list.length === 0) continue
    formulas.push({ itemId: entry.itemId, count: Number(entry.count) || 1, goldCost: Number(entry.goldCost) || 0, costs: list })
  }
  if (formulas.length === 0) throw new Error('building_data.json 中没有材料加工配方。')
  return formulas
}

function costs(list) {
  return Array.isArray(list) ? list.filter(validCost).map(cost => ({ id: String(cost.id), count: cost.count })) : []
}

function findModule(cache, operator, goal) {
  if (!Array.isArray(cache.modules)) throw new Error('培养数据中没有模组消耗，请稍后刷新数据。')
  const candidates = cache.modules.filter(module => module.operatorId === operator.id)
  if (candidates.length === 0) throw new Error(`${operator.name} 没有可升级的模组。`)
  const wanted = String(goal?.type ?? goal?.name ?? '').trim().toUpperCase()
  const found = wanted
    ? candidates.find(module => module.type.toUpperCase() === wanted || module.type.toUpperCase().endsWith(wanted) || module.name.toUpperCase().includes(wanted))
    : candidates.length === 1 ? candidates[0] : null
  if (!found) throw new Error(`${operator.name} 有 ${candidates.map(module => module.type || module.name).join(' / ')} 模组，请指定要升级哪一个。`)
  return found
}

function hasSkillGoals(input) {
  return input.skillLevel?.target !== undefined || (Array.isArray(input.masteries) && input.masteries.length > 0) || (Array.isArray(input.modules) && input.modules.length > 0)
}

function needsInput(text) { return Object.assign(new Error(text), { code: 'MAA_NEEDS_INPUT' }) }

function sourceMetadata(results, now) {
  return { retrievedAt: new Date(now).toISOString(), urls: results.map(item => item.url), etags: results.map(item => item.etag), lastModified: results.map(item => item.lastModified), sha256: results.map(item => item.hash) }
}

async function writeCache(cache, env) {
  await writeJsonAtomically(planningDataFilePath(env), cache, { pretty: false })
}

function validateCache(value) {
  if (!value || value.version !== VERSION || !SERVER_DIRECTORY[value.server] || !Array.isArray(value.operators) || !Array.isArray(value.matrix) || !value.leveling || !value.sources) throw new Error('培养/掉率缓存格式无效。')
  if (!Number.isFinite(Date.parse(value.updatedAt))) throw new Error('培养/掉率缓存时间无效。')
  return value
}

function sumLeveling(leveling, elite, from, to) {
  let exp = 0; let lmd = 0
  for (let level = from; level < to; level += 1) {
    const expValue = leveling.characterExpMap[elite]?.[level - 1]
    const lmdValue = leveling.characterUpgradeCostMap[elite]?.[level - 1]
    if (!Number.isInteger(expValue) || expValue < 0 || !Number.isInteger(lmdValue) || lmdValue < 0) throw new Error(`缺少精${elite} ${level}→${level + 1} 的培养常量。`)
    exp += expValue; lmd += lmdValue
  }
  return { exp, lmd }
}

function validCost(cost) { return cost && typeof cost.id === 'string' && Number.isInteger(cost.count) && cost.count > 0 }
function add(map, id, count) { map.set(String(id), (map.get(String(id)) ?? 0) + count) }
function normalizeServer(value = 'CN') { const server = String(value ?? 'CN').toUpperCase(); if (!SERVER_DIRECTORY[server]) throw new Error(`不支持的掉率服务器：${server}`); return server }
function integer(value, min, max, label) { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min}–${max} 的整数。`); return value }
function message(error) { return error instanceof Error ? error.message : String(error) }
