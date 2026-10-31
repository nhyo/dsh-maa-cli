import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'

const VERSION = 1
const UPDATE_INTERVAL_MS = 24 * 60 * 60_000
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const SERVER_DIRECTORY = { CN: 'cn', US: 'en', JP: 'jp', KR: 'kr' }
const BASE = 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master'
const MATRIX = 'https://penguin-stats.io/PenguinStats/api/v2/result/matrix'
const RECORD_EXP = { 2001: 200, 2002: 400, 2003: 1000, 2004: 2000 }
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
  const urls = options.urls ?? {
    characters: `${BASE}/${directory}/gamedata/excel/character_table.json`,
    constants: `${BASE}/${directory}/gamedata/excel/gamedata_const.json`,
    matrix: `${MATRIX}?server=${server}&show_closed_zones=false`,
  }
  try {
    const [charactersResult, constantsResult, matrixResult] = await Promise.all([
      fetchJson(urls.characters, options), fetchJson(urls.constants, options), fetchJson(urls.matrix, options),
    ])
    const operators = compactOperators(charactersResult.data)
    const leveling = compactLeveling(constantsResult.data)
    const matrix = compactMatrix(matrixResult.data)
    const cache = validateCache({
      version: VERSION, server, updatedAt: new Date(now).toISOString(), stale: false, warning: '', operators, leveling, matrix,
      sources: {
        gamedata: sourceMetadata([charactersResult, constantsResult], now),
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

export function operatorUpgradeRequirements(data, input) {
  const cache = validateCache(data)
  const current = input.current
  const operator = cache.operators.find(item => item.id === current?.id)
    ?? cache.operators.find(item => item.name === input.operator)
  if (!operator) throw new Error(`培养数据中找不到干员“${input.operator}”。`)
  const currentElite = integer(current?.elite, 0, 2, 'current.elite')
  const currentLevel = integer(current?.level, 1, operator.phases[currentElite]?.maxLevel ?? 90, 'current.level')
  const targetElite = integer(input.targetElite ?? 2, currentElite, Math.min(2, operator.phases.length - 1), 'targetElite')
  const targetMax = operator.phases[targetElite]?.maxLevel
  const targetLevel = integer(input.targetLevel ?? 1, 1, targetMax, 'targetLevel')
  if (targetElite === currentElite && targetLevel < currentLevel) throw new Error('培养目标不能低于干员当前等级。')

  const material = new Map()
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
  if (lmd > 0) add(material, '4001', lmd)

  const depot = input.depot?.items ?? {}
  const lowerRecordExp = ['2001', '2002', '2003'].reduce((total, id) => total + (Number(depot[id]) || 0) * RECORD_EXP[id], 0)
  const advancedRecords = Math.ceil(Math.max(0, exp - lowerRecordExp) / RECORD_EXP['2004'])
  if (advancedRecords > 0) add(material, '2004', advancedRecords)

  const requirements = [...material.entries()].map(([itemId, quantity]) => ({ itemId, quantity }))
  return {
    operatorId: operator.id, operator: operator.name,
    current: { elite: currentElite, level: currentLevel }, target: { elite: targetElite, level: targetLevel },
    totalExp: exp, totalLmd: lmd, requirements,
    source: cache.sources.gamedata,
  }
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

async function fetchJson(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch。')
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]) : AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const response = await fetchImpl(url, { signal, headers: { accept: 'application/json', 'user-agent': 'dsh-maa-cli' } })
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`)
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error(`${url} 响应超过安全上限。`)
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error(`${url} 响应超过安全上限。`)
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`${url} 返回的不是有效 JSON。`) }
  return { url, data, etag: response.headers?.get?.('etag') ?? '', lastModified: response.headers?.get?.('last-modified') ?? '', hash: createHash('sha256').update(text).digest('hex') }
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
      evolveCost: Array.isArray(phase?.evolveCost) ? phase.evolveCost.filter(validCost).map(cost => ({ id: String(cost.id), count: cost.count })) : [],
    }))
    operators.push({ id, name: value.name.trim(), rarity, phases })
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

function sourceMetadata(results, now) {
  return { retrievedAt: new Date(now).toISOString(), urls: results.map(item => item.url), etags: results.map(item => item.etag), lastModified: results.map(item => item.lastModified), sha256: results.map(item => item.hash) }
}

async function writeCache(cache, env) {
  const file = planningDataFilePath(env)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  const payload = `${JSON.stringify(cache)}\n`
  try { await writeFile(temporary, payload, 'utf8'); await rename(temporary, file) }
  catch { await writeFile(file, payload, 'utf8'); await rm(temporary, { force: true }).catch(() => {}) }
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
