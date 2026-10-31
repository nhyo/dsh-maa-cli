import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'

const CACHE_VERSION = 1
const DEPOT_MARKER = 'Depot:'

export function depotFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'depot.json')
}

export function extractDepotCallbacks(logText) {
  const text = String(logText ?? '')
  const callbacks = []
  let cursor = 0
  while (cursor < text.length) {
    const marker = text.indexOf(DEPOT_MARKER, cursor)
    if (marker < 0) break
    const start = text.indexOf('{', marker + DEPOT_MARKER.length)
    if (start < 0) break
    const end = jsonObjectEnd(text, start)
    if (end < 0) break
    try {
      const parsed = JSON.parse(text.slice(start, end))
      if (parsed?.taskchain === 'Depot' && parsed?.what === 'DepotInfo') callbacks.push(parsed)
    } catch {
      // Ignore a truncated progress callback and continue looking for done=true.
    }
    cursor = end
  }
  return callbacks
}

export function stripDepotCallbacks(logText) {
  const text = String(logText ?? '')
  const pieces = []
  let cursor = 0
  while (cursor < text.length) {
    const marker = text.indexOf(DEPOT_MARKER, cursor)
    if (marker < 0) { pieces.push(text.slice(cursor)); break }
    const lineStart = text.lastIndexOf('\n', marker - 1) + 1
    const start = text.indexOf('{', marker + DEPOT_MARKER.length)
    const end = start < 0 ? -1 : jsonObjectEnd(text, start)
    if (end < 0) { pieces.push(text.slice(cursor)); break }
    pieces.push(text.slice(cursor, lineStart))
    cursor = end
    if (text[cursor] === '\r') cursor += 1
    if (text[cursor] === '\n') cursor += 1
  }
  return pieces.join('').trim()
}

export function parseCompletedDepot(logText, now = Date.now()) {
  const completed = extractDepotCallbacks(logText).filter(message => message?.details?.done === true).at(-1)
  if (!completed) throw new Error('MAA 没有返回完整的 DepotInfo(done=true) 结果。')
  let raw = completed.details.data
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { throw new Error('MAA 返回的 DepotInfo.data 不是有效 JSON。') }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MAA 返回的 DepotInfo.data 格式无效。')
  const items = {}
  for (const [itemId, quantity] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_@.-]{1,96}$/u.test(itemId)) throw new Error(`MAA 返回了无效的物品 ID：${itemId}`)
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 2_147_483_647) throw new Error(`物品 ${itemId} 的数量无效。`)
    items[itemId] = quantity
  }
  return { version: CACHE_VERSION, scannedAt: new Date(now).toISOString(), items }
}

export async function saveDepot(snapshot, options = {}) {
  const env = options.env ?? process.env
  const file = depotFilePath(env)
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

export async function readDepot(options = {}) {
  try { return validateSnapshot(JSON.parse(await readFile(depotFilePath(options.env ?? process.env), 'utf8'))) } catch { return null }
}

export async function loadItemIndex(resourceDir) {
  const parsed = JSON.parse(await readFile(path.join(resourceDir, 'item_index.json'), 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MAA item_index.json 格式无效。')
  const byId = new Map()
  const byName = new Map()
  for (const [id, item] of Object.entries(parsed)) {
    if (!item || typeof item.name !== 'string' || item.name.trim() === '') continue
    const value = { id, name: item.name.trim(), classifyType: String(item.classifyType ?? '') }
    byId.set(id, value)
    byName.set(value.name.toLocaleLowerCase('zh-CN'), value)
  }
  return { byId, byName }
}

export function queryDepot(snapshot, itemIndex, filters = {}, now = Date.now()) {
  if (snapshot === null) return { available: false, scannedAt: '', ageSeconds: 0, items: [], summary: '尚无仓库缓存。需要先准备并确认一次 Depot 扫描。' }
  const valid = validateSnapshot(snapshot)
  const name = String(filters.name ?? '').trim().toLocaleLowerCase('zh-CN')
  const ids = filters.itemIds === undefined ? null : new Set(filters.itemIds.map(String))
  const maxResults = integer(filters.maxResults ?? 200, 1, 1000, 'maxResults')
  const items = Object.entries(valid.items).map(([id, quantity]) => {
    const metadata = itemIndex?.byId?.get(id)
    return { id, name: metadata?.name ?? '', quantity }
  }).filter(item => {
    if (ids && !ids.has(item.id)) return false
    if (name && !item.name.toLocaleLowerCase('zh-CN').includes(name)) return false
    return true
  }).sort((a, b) => b.quantity - a.quantity || a.id.localeCompare(b.id)).slice(0, maxResults)
  return {
    available: true,
    scannedAt: valid.scannedAt,
    ageSeconds: Math.max(0, Math.floor((now - Date.parse(valid.scannedAt)) / 1000)),
    items,
    summary: `仓库缓存 ${valid.scannedAt}：${Object.keys(valid.items).length} 种物品，当前返回 ${items.length} 种。`,
  }
}

export function formatDepotScanResult(snapshot) {
  const valid = validateSnapshot(snapshot)
  return `仓库识别完成：共识别 ${Object.keys(valid.items).length} 种物品，结果已保存，可用于材料缺口计算。`
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== CACHE_VERSION || !snapshot.items || typeof snapshot.items !== 'object' || Array.isArray(snapshot.items)) throw new Error('仓库缓存格式无效。')
  const scannedAt = new Date(snapshot.scannedAt)
  if (!Number.isFinite(scannedAt.getTime())) throw new Error('仓库缓存时间无效。')
  const items = {}
  for (const [id, quantity] of Object.entries(snapshot.items)) items[id] = integer(quantity, 0, 2_147_483_647, id)
  return { version: CACHE_VERSION, scannedAt: scannedAt.toISOString(), items }
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min}–${max} 的整数。`)
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
