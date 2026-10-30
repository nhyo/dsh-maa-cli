import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from './state.js'

const CACHE_VERSION = 1
const OPER_BOX_MARKER = 'OperBox:'

export function operatorBoxFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'operator-box.json')
}

export function extractOperBoxCallbacks(logText) {
  const text = String(logText ?? '')
  const callbacks = []
  let cursor = 0
  while (cursor < text.length) {
    const marker = text.indexOf(OPER_BOX_MARKER, cursor)
    if (marker < 0) break
    const start = text.indexOf('{', marker + OPER_BOX_MARKER.length)
    if (start < 0) break
    const end = jsonObjectEnd(text, start)
    if (end < 0) break
    try {
      const parsed = JSON.parse(text.slice(start, end))
      if (parsed?.taskchain === 'OperBox' && parsed?.what === 'OperBoxInfo') callbacks.push(parsed)
    } catch {
      // Keep looking: unrelated log text or a truncated progress message must
      // not hide a later complete callback.
    }
    cursor = end
  }
  return callbacks
}

export function stripOperBoxCallbacks(logText) {
  const text = String(logText ?? '')
  const pieces = []
  let cursor = 0
  while (cursor < text.length) {
    const marker = text.indexOf(OPER_BOX_MARKER, cursor)
    if (marker < 0) {
      pieces.push(text.slice(cursor))
      break
    }
    const lineStart = text.lastIndexOf('\n', marker - 1) + 1
    const start = text.indexOf('{', marker + OPER_BOX_MARKER.length)
    const end = start < 0 ? -1 : jsonObjectEnd(text, start)
    if (end < 0) {
      pieces.push(text.slice(cursor))
      break
    }
    pieces.push(text.slice(cursor, lineStart))
    cursor = end
    if (text[cursor] === '\r') cursor += 1
    if (text[cursor] === '\n') cursor += 1
  }
  return pieces.join('').trim()
}

export function parseCompletedOperatorBox(logText, now = Date.now()) {
  const completed = extractOperBoxCallbacks(logText)
    .filter(message => message?.details?.done === true)
    .at(-1)
  if (!completed) throw new Error('MAA 没有返回完整的 OperBoxInfo(done=true) 结果。')
  const own = completed.details.own_opers
  if (!Array.isArray(own)) throw new Error('MAA 返回的 OperBoxInfo 缺少 own_opers。')

  const byId = new Map()
  for (const raw of own) {
    const operator = normalizeOperator(raw)
    if (byId.has(operator.id)) throw new Error(`MAA 返回了重复的干员 ID：${operator.id}`)
    byId.set(operator.id, operator)
  }
  const operators = [...byId.values()].sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name, 'zh-CN'))
  return {
    version: CACHE_VERSION,
    scannedAt: new Date(now).toISOString(),
    operators,
  }
}

export async function saveOperatorBox(snapshot, options = {}) {
  const env = options.env ?? process.env
  const file = operatorBoxFilePath(env)
  await mkdir(path.dirname(file), { recursive: true })
  const payload = `${JSON.stringify(validateSnapshot(snapshot), null, 2)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, file)
  } catch {
    await writeFile(file, payload, 'utf8')
    await rm(temporary, { force: true }).catch(() => {})
  }
  return file
}

export async function readOperatorBox(options = {}) {
  const env = options.env ?? process.env
  try {
    return validateSnapshot(JSON.parse(await readFile(operatorBoxFilePath(env), 'utf8')))
  } catch {
    return null
  }
}

export function queryOperatorBox(snapshot, filters = {}, now = Date.now()) {
  if (snapshot === null) {
    return {
      available: false, scannedAt: '', ageSeconds: 0, totalOwned: 0,
      matched: 0, truncated: false, operators: [],
      summary: '尚无干员 Box 缓存。需要先准备并确认一次 OperBox 扫描。',
    }
  }
  const valid = validateSnapshot(snapshot)
  const rarity = filters.rarity
  const name = String(filters.name ?? '').trim().toLocaleLowerCase('zh-CN')
  const eliteBelow = filters.eliteBelow
  const maxResults = integer(filters.maxResults ?? 200, 1, 500, 'maxResults')
  if (rarity !== undefined) integer(rarity, 1, 6, 'rarity')
  if (eliteBelow !== undefined) integer(eliteBelow, 1, 3, 'eliteBelow')

  const matching = valid.operators.filter(operator => {
    if (rarity !== undefined && operator.rarity !== rarity) return false
    if (eliteBelow !== undefined && operator.elite >= eliteBelow) return false
    if (name !== '' && !operator.name.toLocaleLowerCase('zh-CN').includes(name)) return false
    return true
  })
  const operators = matching.slice(0, maxResults)
  const ageSeconds = Math.max(0, Math.floor((now - Date.parse(valid.scannedAt)) / 1000))
  return {
    available: true,
    scannedAt: valid.scannedAt,
    ageSeconds,
    totalOwned: valid.operators.length,
    matched: matching.length,
    truncated: operators.length < matching.length,
    operators,
    summary: formatOperatorBoxSummary(valid, { rarity, name: filters.name, eliteBelow, count: matching.length }),
  }
}

export function formatOperatorBoxScanResult(snapshot) {
  const valid = validateSnapshot(snapshot)
  const sixStars = valid.operators.filter(operator => operator.rarity === 6)
  const names = sixStars.map(operator => operator.name).join('、') || '无'
  return `干员 Box 识别完成：共识别到 ${valid.operators.length} 名已拥有干员，其中六星 ${sixStars.length} 名。\n六星干员：${names}\n结果已保存；之后可以直接询问等级、精英化和潜能。\n\n是否需要根据这次 Box 生成培养建议？回复“需要培养建议”即可。`
}

function formatOperatorBoxSummary(snapshot, filters) {
  const conditions = []
  if (filters.rarity !== undefined) conditions.push(`${filters.rarity} 星`)
  if (filters.eliteBelow !== undefined) conditions.push(`精英化低于 ${filters.eliteBelow}`)
  if (String(filters.name ?? '').trim() !== '') conditions.push(`名称包含“${String(filters.name).trim()}”`)
  const label = conditions.length ? conditions.join('、') : '全部已拥有干员'
  return `${label}：${filters.count} 名；缓存扫描时间 ${snapshot.scannedAt}。`
}

function normalizeOperator(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MAA 返回了无效的干员记录。')
  const id = requiredString(raw.id, 'operator.id', 96)
  const name = requiredString(raw.name, 'operator.name', 96)
  if (raw.own !== true) throw new Error(`own_opers 中的干员没有 owned 标记：${name}`)
  return {
    id,
    name,
    rarity: integer(raw.rarity, 1, 6, `${name}.rarity`),
    elite: integer(raw.elite, 0, 2, `${name}.elite`),
    level: integer(raw.level, 1, 100, `${name}.level`),
    potential: integer(raw.potential, 1, 6, `${name}.potential`),
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== CACHE_VERSION || !Array.isArray(snapshot.operators)) throw new Error('干员 Box 缓存格式无效。')
  const scannedAt = new Date(snapshot.scannedAt)
  if (!Number.isFinite(scannedAt.getTime())) throw new Error('干员 Box 缓存时间无效。')
  const operators = snapshot.operators.map(operator => normalizeCachedOperator(operator))
  return { version: CACHE_VERSION, scannedAt: scannedAt.toISOString(), operators }
}

function normalizeCachedOperator(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('干员 Box 缓存记录无效。')
  const name = requiredString(raw.name, 'operator.name', 96)
  return {
    id: requiredString(raw.id, 'operator.id', 96),
    name,
    rarity: integer(raw.rarity, 1, 6, `${name}.rarity`),
    elite: integer(raw.elite, 0, 2, `${name}.elite`),
    level: integer(raw.level, 1, 100, `${name}.level`),
    potential: integer(raw.potential, 1, 6, `${name}.potential`),
  }
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min}–${max} 的整数。`)
  return value
}

function requiredString(value, label, maxLength) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) throw new Error(`${label} 无效。`)
  return value
}

function jsonObjectEnd(text, start) {
  let depth = 0
  let string = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (string) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') string = false
      continue
    }
    if (char === '"') string = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}
