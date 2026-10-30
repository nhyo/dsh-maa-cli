import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildTaskDocument } from '../commands/planner.js'
import { stateDirectory } from '../runtime/state.js'
import { previewStrategy } from './compiler.js'

const STORE_VERSION = 1
export const STRATEGY_MEMORY_LIMIT = 20
const MINIMUM_STRATEGY_CORE = '6.18.0'
let memoryQueue = Promise.resolve()

export function strategyMemoryFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'strategy-memory.json')
}

export function parseMaaCompatibility(output) {
  const text = String(output ?? '')
  const cli = /maa-cli\s+v?(\d+\.\d+\.\d+)/iu.exec(text)?.[1]
  const core = /MaaCore\s+v?(\d+\.\d+\.\d+)/iu.exec(text)?.[1]
  if (!cli || !core) throw new Error('无法从 maa-cli version 输出识别 maa-cli/MaaCore 版本')
  return { cliVersion: cli, coreVersion: core }
}

export async function readStrategyMemory(options = {}) {
  const env = options.env ?? process.env
  try {
    const parsed = JSON.parse(await readFile(strategyMemoryFilePath(env), 'utf8'))
    if (parsed?.version !== STORE_VERSION || !plain(parsed.categories)) return emptyStore()
    const categories = {}
    for (const [category, entries] of Object.entries(parsed.categories)) {
      if (!Array.isArray(entries)) continue
      categories[category] = entries.filter(validEntry).slice(-STRATEGY_MEMORY_LIMIT)
    }
    return { version: STORE_VERSION, categories }
  } catch {
    return emptyStore()
  }
}

export async function applyStrategyMemory(strategy, options) {
  const resourceDir = requireAbsolute(options.resourceDir, 'MAA resource directory')
  const compatibility = normalizeCompatibility(options.compatibility)
  const env = options.env ?? process.env
  const snapshot = await readStrategyMemory({ env })
  const atoms = dedupeStrategyAtoms(strategyAtoms(strategy)).map(current => {
    const remembered = snapshot.categories[current.category]?.find(entry => entry.semanticKey === current.semanticKey)
    if (!remembered || !compatibleEntry(remembered, current, compatibility)) return current
    // Reuse the persisted canonical unit when its parameters are unchanged.
    // Current applicability/order always wins, so cross-map tactics are
    // recalculated on the requested stage instead of reusing old coordinates.
    if (JSON.stringify(remembered.atom.payload) !== JSON.stringify(current.payload)) return current
    return { ...remembered.atom, applicability: current.applicability, label: current.label, order: current.order }
  })
  const conflicted = conflictIndexes(atoms)
  const valid = []
  const rejected = []

  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index]
    if (conflicted.has(index)) {
      rejected.push({ request: atom.label, reason: '同一请求包含互相冲突的策略，未执行也未写入记忆' })
      continue
    }
    try {
      const candidate = strategyFromAtoms({ ...strategy, unsupported: [] }, [atom])
      const preview = await previewStrategy(candidate, resourceDir)
      if (preview.unsupported.length) {
        rejected.push({ request: atom.label, reason: preview.unsupported.map(item => item.reason).join('；') })
        continue
      }
      valid.push(atom)
    } catch (error) {
      rejected.push({ request: atom.label, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const memory = await updateMemory(env, store => {
    let reused = 0
    let stored = 0
    const touched = new Set()
    const now = new Date().toISOString()
    for (const atom of valid) {
      const entries = store.categories[atom.category] ?? []
      const existingIndex = entries.findIndex(entry => entry.semanticKey === atom.semanticKey)
      const existing = existingIndex >= 0 ? entries[existingIndex] : null
      if (existing && compatibleEntry(existing, atom, compatibility)) reused += 1
      else stored += 1
      const entry = {
        id: existing?.id ?? randomUUID(),
        category: atom.category,
        semanticKey: atom.semanticKey,
        source: atom.source,
        atom,
        applicability: atom.applicability,
        compatibility: {
          ...compatibility,
          minimumCore: atom.source === 'strategy' ? MINIMUM_STRATEGY_CORE : compatibility.coreVersion,
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        uses: (existing?.uses ?? 0) + 1,
      }
      if (existingIndex >= 0) entries.splice(existingIndex, 1)
      entries.push(entry)
      store.categories[atom.category] = entries.slice(-STRATEGY_MEMORY_LIMIT)
      touched.add(atom.category)
    }
    return { reused, stored, categories: [...touched].sort() }
  })

  return {
    strategy: strategyFromAtoms(strategy, valid, rejected),
    memory: { ...memory, rejected: rejected.length },
    rejected,
  }
}

export async function rememberPlanStrategies(steps, compatibilityInput, options = {}) {
  const compatibility = normalizeCompatibility(compatibilityInput)
  const env = options.env ?? process.env
  const requested = steps.map((step, index) => planAtom(step, index))
  const atoms = requested.filter(atom => atom.step.type !== 'Custom')
  const rejected = requested.length - atoms.length
  for (const atom of atoms) buildTaskDocument([atom.step])
  return await updateMemory(env, store => {
    let reused = 0
    let stored = 0
    const categories = new Set()
    const now = new Date().toISOString()
    for (const atom of atoms) {
      const entries = store.categories[atom.category] ?? []
      const existingIndex = entries.findIndex(entry => entry.semanticKey === atom.semanticKey)
      const existing = existingIndex >= 0 ? entries[existingIndex] : null
      if (existing && compatibleEntry(existing, atom, compatibility)) reused += 1
      else stored += 1
      const entry = {
        id: existing?.id ?? randomUUID(), category: atom.category,
        semanticKey: atom.semanticKey, source: 'plan', atom,
        applicability: atom.applicability,
        compatibility: { ...compatibility, minimumCore: compatibility.coreVersion },
        createdAt: existing?.createdAt ?? now, updatedAt: now, uses: (existing?.uses ?? 0) + 1,
      }
      if (existingIndex >= 0) entries.splice(existingIndex, 1)
      entries.push(entry)
      store.categories[atom.category] = entries.slice(-STRATEGY_MEMORY_LIMIT)
      categories.add(atom.category)
    }
    return { reused, stored, rejected, categories: [...categories].sort() }
  })
}

export async function clearStrategyMemoryForTest(options = {}) {
  await rm(strategyMemoryFilePath(options.env ?? process.env), { force: true })
}

function strategyAtoms(strategy) {
  const atoms = []
  if (strategy.kind === 'Roguelike') {
    const applicability = { theme: strategy.theme, mode: strategy.step.mode ?? 0 }
    atoms.push(atom('roguelike', `theme:${strategy.theme}`, 'theme', { theme: strategy.theme }, applicability, `切换肉鸽主题 ${strategy.theme}`))
    for (const item of strategy.recruitment?.prioritize ?? []) atoms.push(atom('roguelike', `recruit:${strategy.theme}:prioritize:${item.name}`, 'recruit_prioritize', item, applicability, `优先招募 ${item.name}`))
    for (const item of strategy.recruitment?.promote ?? []) atoms.push(atom('roguelike', `recruit:${strategy.theme}:promote:${item.name}`, 'recruit_promote', item, applicability, `优先精二 ${item.name}`))
    for (const item of strategy.recruitment?.teamComplete ?? []) {
      const groups = [...item.groups].sort()
      atoms.push(atom('roguelike', `team:${strategy.theme}:${groups.join('|')}`, 'team_complete', item, applicability, `阵容完备 ${groups.join('、')}`))
    }
    for (const name of strategy.shopping?.prioritize ?? []) atoms.push(atom('roguelike', `shopping:${strategy.theme}:${name}`, 'shopping_prioritize', { name }, applicability, `优先购买 ${name}`, `shopping:${strategy.theme}:${name}`))
    for (const name of strategy.shopping?.avoid ?? []) atoms.push(atom('roguelike', `shopping:${strategy.theme}:${name}`, 'shopping_avoid', { name }, applicability, `禁买 ${name}`, `shopping:${strategy.theme}:${name}`))
    for (const item of strategy.encounters ?? []) atoms.push(atom('roguelike', `encounter:${strategy.theme}:${item.name}`, 'encounter', item, applicability, `事件 ${item.name} 选择第 ${item.choose} 项`))
    return atoms
  }

  const applicability = { stageName: strategy.stageName }
  for (const item of strategy.tactics ?? []) {
    // Tactical intent is map-independent memory. Coordinates are never stored;
    // the compiler recalculates and validates them against the current map.
    atoms.push(atom('combat', `tactic:${item.kind}`, `tactic_${item.kind}`, item, applicability, item.kind === 'block_entrance' ? '堵门' : '守蓝门'))
  }
  for (let index = 0; index < (strategy.actions ?? []).length; index += 1) {
    const item = strategy.actions[index]
    const name = item.name ?? '_global'
    atoms.push(atom('combat', `action:${strategy.stageName}:${item.type}:${name}`, 'action', item, applicability, `${item.type}${item.name ? ` ${item.name}` : ''}`, '', index))
  }
  return atoms
}

function strategyFromAtoms(base, atoms, rejected = []) {
  if (base.kind === 'Roguelike') {
    const result = {
      ...base,
      recruitment: { prioritize: [], promote: [], teamComplete: [] },
      shopping: { prioritize: [], avoid: [] }, encounters: [],
      unsupported: [...(base.unsupported ?? []), ...rejected],
    }
    for (const current of atoms) {
      if (current.operation === 'recruit_prioritize') result.recruitment.prioritize.push(current.payload)
      else if (current.operation === 'recruit_promote') result.recruitment.promote.push(current.payload)
      else if (current.operation === 'team_complete') result.recruitment.teamComplete.push(current.payload)
      else if (current.operation === 'shopping_prioritize') result.shopping.prioritize.push(current.payload.name)
      else if (current.operation === 'shopping_avoid') result.shopping.avoid.push(current.payload.name)
      else if (current.operation === 'encounter') result.encounters.push(current.payload)
    }
    return result
  }
  return {
    ...base,
    tactics: atoms.filter(item => item.operation.startsWith('tactic_')).map(item => item.payload),
    actions: atoms.filter(item => item.operation === 'action').sort((a, b) => a.order - b.order).map(item => item.payload),
    unsupported: [...(base.unsupported ?? []), ...rejected],
  }
}

function planAtom(step, index) {
  const category = categoryForStep(step.type)
  const anchor = step.type === 'Fight' ? (step.stage ?? '_current')
    : step.type === 'Roguelike' ? (step.theme ?? '_theme')
      : step.type === 'Custom' ? (step.taskName ?? '_custom') : ''
  return {
    category, semanticKey: `task:${step.type}${anchor ? `:${anchor}` : ''}`,
    source: 'plan', operation: `task_${step.type}`, step: structuredClone(step), order: index,
    applicability: { type: step.type, ...(step.stage ? { stageName: step.stage } : {}), ...(step.theme ? { theme: step.theme } : {}) },
    label: step.type,
  }
}

function categoryForStep(type) {
  if (type === 'Fight') return 'combat'
  if (type === 'Roguelike') return 'roguelike'
  if (type === 'ReclamationAlgorithm') return 'reclamation'
  return String(type).replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase()
}

function atom(category, semanticKey, operation, payload, applicability, label, conflictKey = '', order = 0) {
  return { category, semanticKey, source: 'strategy', operation, payload: structuredClone(payload), applicability, label, conflictKey, order }
}

function conflictIndexes(atoms) {
  const groups = new Map()
  for (let index = 0; index < atoms.length; index += 1) {
    const key = atoms[index].conflictKey
    if (!key) continue
    const group = groups.get(key) ?? []
    group.push(index)
    groups.set(key, group)
  }
  const result = new Set()
  for (const indexes of groups.values()) {
    const operations = new Set(indexes.map(index => atoms[index].operation))
    if (operations.size > 1) for (const index of indexes) result.add(index)
  }
  return result
}

function dedupeStrategyAtoms(atoms) {
  const latest = new Map()
  for (let index = 0; index < atoms.length; index += 1) {
    if (atoms[index].operation !== 'action') latest.set(`${atoms[index].semanticKey}\0${atoms[index].operation}`, index)
  }
  return atoms.filter((current, index) => current.operation === 'action' || latest.get(`${current.semanticKey}\0${current.operation}`) === index)
}

function compatibleEntry(entry, atom, compatibility) {
  const saved = entry.compatibility
  if (!plain(saved) || !sameCliLine(saved.cliVersion, compatibility.cliVersion)) return false
  if (major(saved.coreVersion) !== major(compatibility.coreVersion)) return false
  if (compareVersions(compatibility.coreVersion, saved.minimumCore ?? saved.coreVersion) < 0) return false
  if (atom.semanticKey.startsWith('tactic:')) return true
  return JSON.stringify(entry.applicability ?? {}) === JSON.stringify(atom.applicability ?? {})
}

function normalizeCompatibility(value) {
  if (!plain(value)) throw new TypeError('MAA compatibility is required')
  return {
    cliVersion: version(value.cliVersion, 'maa-cli version'),
    coreVersion: version(value.coreVersion, 'MaaCore version'),
  }
}

function sameCliLine(a, b) {
  const left = versionParts(a)
  const right = versionParts(b)
  return left[0] === right[0] && (left[0] !== 0 || left[1] === right[1])
}

function compareVersions(a, b) {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}

function major(value) { return versionParts(value)[0] }
function version(value, label) { const text = String(value ?? ''); if (!/^\d+\.\d+\.\d+$/u.test(text)) throw new TypeError(`${label} is invalid`); return text }
function versionParts(value) { return version(value, 'version').split('.').map(Number) }
function validEntry(value) { return plain(value) && typeof value.semanticKey === 'string' && typeof value.category === 'string' && plain(value.atom) }
function emptyStore() { return { version: STORE_VERSION, categories: {} } }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function requireAbsolute(value, label) { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`); return path.resolve(value) }

async function updateMemory(env, update) {
  const previous = memoryQueue
  let release
  memoryQueue = new Promise(resolve => { release = resolve })
  await previous
  try {
    const store = await readStrategyMemory({ env })
    const result = update(store)
    await writeStrategyMemory(store, env)
    return result
  } finally {
    release()
  }
}

async function writeStrategyMemory(store, env) {
  const file = strategyMemoryFilePath(env)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
