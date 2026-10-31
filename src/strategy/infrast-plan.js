import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory, writeJsonAtomically } from '../runtime/state.js'

// Compiles a structured base schedule (prepared by the model from natural
// language) into MAA's custom base-scheduling JSON (Infrast mode 10000).
// Operator names are checked against MAA's battle_data.json registry; names
// MAA would not recognize are dropped with a reason instead of being guessed.

const ROOMS = {
  control: { facility: 'Control', label: '控制中枢', maxRooms: 1, maxOperators: 5 },
  manufacture: { facility: 'Mfg', label: '制造站', maxRooms: 5, maxOperators: 3, products: ['Battle Record', 'Pure Gold', 'Dualchip', 'Originium Shard'] },
  trading: { facility: 'Trade', label: '贸易站', maxRooms: 5, maxOperators: 3, products: ['LMD', 'Orundum'] },
  power: { facility: 'Power', label: '发电站', maxRooms: 3, maxOperators: 1 },
  meeting: { facility: 'Reception', label: '会客室', maxRooms: 1, maxOperators: 2 },
  hire: { facility: 'Office', label: '办公室', maxRooms: 1, maxOperators: 1 },
  dormitory: { facility: 'Dorm', label: '宿舍', maxRooms: 4, maxOperators: 5 },
  processing: { facility: 'Processing', label: '加工站', maxRooms: 1, maxOperators: 1 },
}
const PRODUCT_ALIASES = new Map([
  ['赤金', 'Pure Gold'], ['金', 'Pure Gold'], ['赤金线', 'Pure Gold'], ['pure gold', 'Pure Gold'], ['puregold', 'Pure Gold'],
  ['作战记录', 'Battle Record'], ['经验', 'Battle Record'], ['经验书', 'Battle Record'], ['录像', 'Battle Record'], ['battle record', 'Battle Record'], ['combatrecord', 'Battle Record'],
  ['芯片', 'Dualchip'], ['芯片组', 'Dualchip'], ['dualchip', 'Dualchip'], ['chip', 'Dualchip'],
  ['源石碎片', 'Originium Shard'], ['碎片', 'Originium Shard'], ['originium shard', 'Originium Shard'], ['originstone', 'Originium Shard'],
  ['龙门币', 'LMD'], ['钱', 'LMD'], ['lmd', 'LMD'], ['money', 'LMD'],
  ['合成玉', 'Orundum'], ['玉', 'Orundum'], ['orundum', 'Orundum'], ['syntheticjade', 'Orundum'],
])
const DEFAULT_FACILITIES = ['Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Dorm']
const MAX_PLANS = 6
const MAX_SAVED = 20

export function infrastPlanFilePath(env = process.env) { return path.join(stateDirectory(env), 'infrast-plans.json') }

export function compileInfrastPlan(input, operators, options = {}) {
  if (!plain(input) || !Array.isArray(input.plans) || input.plans.length === 0) throw new TypeError('排班至少需要一个 plans 方案。')
  if (input.plans.length > MAX_PLANS) throw new TypeError(`排班最多 ${MAX_PLANS} 个方案。`)
  if (!(operators instanceof Map)) throw new Error('缺少 MAA 的 battle_data.json，无法确认干员名称，已停止生成排班。')
  const supported = []
  const unsupported = []
  const notes = []
  const usedFacilities = new Set()
  const plans = input.plans.map((plan, planIndex) => {
    if (!plain(plan) || !plain(plan.rooms)) throw new TypeError(`plans[${planIndex}].rooms 必填。`)
    const label = text(plan.name, 40) || `方案${planIndex + 1}`
    const seen = new Set()
    const rooms = {}
    for (const [key, raw] of Object.entries(plan.rooms)) {
      const definition = ROOMS[key]
      if (!definition) { unsupported.push({ request: `${label}：${key}`, reason: 'MAA 排班协议没有这种设施' }); continue }
      if (!Array.isArray(raw) || raw.length === 0) continue
      const expanded = raw.flatMap(room => Array.from({ length: plain(room) && Number.isInteger(room.count) ? Math.min(Math.max(room.count, 1), definition.maxRooms) : 1 }, () => room))
      if (expanded.length > definition.maxRooms) unsupported.push({ request: `${label}：${definition.label}第 ${definition.maxRooms + 1} 间及以后`, reason: `${definition.label}最多 ${definition.maxRooms} 间` })
      rooms[key] = expanded.slice(0, definition.maxRooms).map((room, roomIndex) => compileRoom(room, definition, `${label}·${definition.label}${roomIndex + 1}`, operators, seen, supported, unsupported, notes))
      usedFacilities.add(definition.facility)
    }
    if (Object.keys(rooms).length === 0) throw new Error(`${label} 没有任何可执行的房间安排。`)
    const result = { name: label, rooms }
    const description = text(plan.description, 200)
    if (description) result.description = description
    if (Array.isArray(plan.period) && plan.period.length > 0) {
      result.period = plan.period.map((range, index) => {
        if (!Array.isArray(range) || range.length !== 2 || !range.every(value => /^([01]\d|2[0-3]):[0-5]\d$/u.test(String(value)))) throw new TypeError(`${label}.period[${index}] 必须是 ["hh:mm","hh:mm"]。`)
        return range.map(String)
      })
    }
    if (plain(plan.drones)) {
      const room = plan.drones.room === 'manufacture' ? 'manufacture' : 'trading'
      const index = Number.isInteger(plan.drones.index) && plan.drones.index >= 1 && plan.drones.index <= 5 ? plan.drones.index : 1
      result.drones = { enable: plan.drones.enable !== false, room, index, order: plan.drones.order === 'post' ? 'post' : 'pre' }
      supported.push(`${label}：无人机加速${ROOMS[room].label}${index}`)
    }
    if (plain(plan.fiammetta) && plan.fiammetta.target) {
      const target = operatorName(plan.fiammetta.target, operators)
      if (!target) unsupported.push({ request: `${label}：菲亚梅塔目标 ${plan.fiammetta.target}`, reason: 'MAA 干员数据中没有该干员' })
      else result.Fiammetta = { enable: true, target, order: plan.fiammetta.order === 'post' ? 'post' : 'pre' }
    }
    return result
  })
  const facilities = Array.isArray(input.facilities) && input.facilities.length > 0
    ? [...new Set(input.facilities.map(String))]
    : [...new Set([...DEFAULT_FACILITIES, ...usedFacilities])]
  const document = { title: text(input.title, 60) || 'DSH 自定义排班', plans }
  const description = text(input.description, 200)
  if (description) document.description = description
  const warnings = ownershipWarnings(document, options.box)
  return { document, facilities, supported, unsupported, notes: [...new Set(notes)], warnings }
}

export function describeInfrastPlan(document) {
  return document.plans.map(plan => `${plan.name}：${Object.entries(plan.rooms).map(([key, rooms]) => `${ROOMS[key].label}[${rooms.map(room => room.skip ? '跳过' : `${(room.operators ?? []).join('/') || '自动'}${room.autofill && room.operators?.length ? '+补位' : ''}${room.product ? `(${room.product})` : ''}`).join('，')}]`).join(' ')}`)
}

export async function listSavedInfrastPlans(options = {}) {
  try {
    const parsed = JSON.parse(await readFile(infrastPlanFilePath(options.env ?? process.env), 'utf8'))
    return Array.isArray(parsed?.plans) ? parsed.plans : []
  } catch { return [] }
}

export async function saveInfrastPlan(name, compiled, options = {}) {
  const title = text(name, 40)
  if (!title) throw new TypeError('保存排班需要名称。')
  const plans = (await listSavedInfrastPlans(options)).filter(item => item.name !== title)
  const entry = { name: title, document: compiled.document, facilities: compiled.facilities, savedAt: new Date(options.now ?? Date.now()).toISOString() }
  plans.unshift(entry)
  await writeJsonAtomically(infrastPlanFilePath(options.env ?? process.env), { version: 1, plans: plans.slice(0, MAX_SAVED) })
  return entry
}

export async function deleteInfrastPlan(name, options = {}) {
  const plans = await listSavedInfrastPlans(options)
  const kept = plans.filter(item => item.name !== name)
  if (kept.length === plans.length) return false
  await writeJsonAtomically(infrastPlanFilePath(options.env ?? process.env), { version: 1, plans: kept })
  return true
}

// Names MAA knows but the player does not own cannot be placed. With a Box
// cache this is reported before confirmation; without one nothing is claimed.
export function ownershipWarnings(document, box) {
  if (!box || !Array.isArray(box.operators)) return []
  const owned = new Set(box.operators.map(operator => operator.name))
  const missing = new Set()
  for (const plan of document.plans ?? []) {
    for (const rooms of Object.values(plan.rooms ?? {})) for (const room of rooms) for (const name of [...(room.operators ?? []), ...(room.candidates ?? [])]) if (!owned.has(name)) missing.add(name)
    if (plan.Fiammetta?.target && !owned.has(plan.Fiammetta.target)) missing.add(plan.Fiammetta.target)
  }
  return missing.size ? [`按 ${box.scannedAt} 的 Box 缓存，你还没有：${[...missing].join('、')}；MAA 会跳过这些干员，相应房间可能空位或改用补位`] : []
}

function compileRoom(room, definition, label, operators, seen, supported, unsupported, notes) {
  if (!plain(room)) throw new TypeError(`${label} 必须是对象。`)
  if (room.skip === true) { supported.push(`${label}：跳过换班`); return { skip: true } }
  const result = {}
  const names = []
  for (const raw of Array.isArray(room.operators) ? room.operators : []) {
    const name = operatorName(raw, operators)
    if (!name) { unsupported.push({ request: `${label}：${raw}`, reason: 'MAA 干员数据中没有该干员' }); continue }
    if (seen.has(name)) { unsupported.push({ request: `${label}：${name}`, reason: '同一方案中该干员已安排在其他房间' }); continue }
    if (names.length >= definition.maxOperators) { unsupported.push({ request: `${label}：${name}`, reason: `${definition.label}最多 ${definition.maxOperators} 人` }); continue }
    seen.add(name)
    names.push(name)
  }
  const candidates = []
  for (const raw of Array.isArray(room.candidates) ? room.candidates : []) {
    const name = operatorName(raw, operators)
    if (!name) { unsupported.push({ request: `${label}备选：${raw}`, reason: 'MAA 干员数据中没有该干员' }); continue }
    if (!seen.has(name)) candidates.push(name)
  }
  if (names.length) result.operators = names
  if (room.sort === true) result.sort = true
  if (candidates.length) result.candidates = candidates
  // MAA treats autofill and candidates as mutually exclusive.
  const autofill = candidates.length === 0 && (room.autofill === true || names.length === 0)
  if (autofill) result.autofill = true
  if (room.product !== undefined) {
    const product = normalizeProduct(room.product)
    if (!product || !definition.products?.includes(product)) {
      unsupported.push({ request: `${label}：产物 ${room.product}`, reason: definition.products ? `${definition.label}可选产物：${definition.products.join(' / ')}` : `${definition.label}没有产物设置` })
    } else {
      result.product = product
      notes.push('MAA 不会切换制造站/贸易站的生产线；product 只告诉 MAA 该房间当前生产什么，以便挑选对应技能的干员。需要换生产线请先在游戏内调整。')
    }
  }
  supported.push(`${label}：${names.length ? names.join('、') : '自动选人'}${autofill && names.length ? '，其余位置自动补位' : ''}${candidates.length ? `，备选 ${candidates.join('、')}` : ''}${result.product ? `，产物 ${result.product}` : ''}`)
  return result
}

function operatorName(raw, operators) {
  const value = String(raw ?? '').trim().replace(/\s+/gu, '')
  if (!value) return ''
  if (operators.has(value)) return value
  const lower = value.toLowerCase()
  for (const name of operators.keys()) if (name.toLowerCase() === lower) return name
  return ''
}

function normalizeProduct(raw) {
  const value = String(raw ?? '').trim()
  for (const products of Object.values(ROOMS).map(item => item.products ?? [])) if (products.includes(value)) return value
  return PRODUCT_ALIASES.get(value.toLowerCase()) ?? PRODUCT_ALIASES.get(value.replace(/\s+/gu, '').toLowerCase()) ?? ''
}

function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
