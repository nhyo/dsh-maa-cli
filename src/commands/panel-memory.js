import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'

const MEMORY_VERSION = 1
// One entry per roguelike theme is enough; the cap only stops the file from
// growing forever after a MAA resource update adds new themes.
const MAX_ENTRIES = 24

/**
 * A tiny persistence layer for the confirmation panel: the settings a human
 * picked last time are offered again next time, per roguelike theme. It lives
 * in the same state directory as pending plans, so a desktop restart keeps it.
 */
export function panelMemoryFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'panel-memory.json')
}

function emptyMemory() {
  return { version: MEMORY_VERSION, entries: {} }
}

export async function readPanelMemory(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(panelMemoryFilePath(env), 'utf8'))
    if (parsed?.version !== MEMORY_VERSION) return emptyMemory()
    if (typeof parsed.entries !== 'object' || parsed.entries === null || Array.isArray(parsed.entries)) return emptyMemory()
    return { version: MEMORY_VERSION, entries: parsed.entries }
  } catch {
    return emptyMemory()
  }
}

async function writePanelMemory(memory, env = process.env) {
  const file = panelMemoryFilePath(env)
  await mkdir(path.dirname(file), { recursive: true })
  const payload = `${JSON.stringify({ version: MEMORY_VERSION, entries: memory.entries }, null, 2)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, file)
  } catch {
    // Same fallback as pending-plan state: some directories reject rename.
    await writeFile(file, payload, 'utf8').catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export function panelMemoryKey(panel) {
  // Only roguelike settings are remembered: they are the ones a human tunes by
  // hand. Replaying a remembered stage/times on a Fight plan would silently
  // change what the plan was written to do.
  if (!panel || panel.type !== 'Roguelike') return ''
  const theme = panel.values?.theme
  return typeof theme === 'string' && theme !== '' ? `Roguelike:${theme}` : ''
}

function isStorable(value) {
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && value !== '' && value.length <= 200
}

function allowedValues(field, theme) {
  return (field.options ?? [])
    .filter(item => {
      const scope = item?.when
      if (!scope || typeof scope !== 'object') return true
      if (scope.key !== 'theme' || !Array.isArray(scope.in)) return false
      return scope.in.includes(theme)
    })
    .map(item => item.value)
}

function candidateApplies(field, theme, candidate) {
  if (candidate === undefined || candidate === null || candidate === '') return false
  // Multi-select and list fields are order-sensitive and validated field by
  // field in the panel; remembering them would silently change a plan shape.
  if (field.kind === 'multi' || field.kind === 'list') return false
  if (field.kind === 'boolean') return typeof candidate === 'boolean'
  if (field.kind === 'integer') {
    if (!Number.isInteger(candidate)) return false
    if (field.min !== undefined && candidate < field.min) return false
    if (field.max !== undefined && candidate > field.max) return false
    return true
  }
  if (field.kind === 'number') {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return false
    if (field.min !== undefined && candidate < field.min) return false
    if (field.max !== undefined && candidate > field.max) return false
    return true
  }
  if (field.kind === 'select') {
    const values = allowedValues(field, theme)
    return values.length === 0 || values.includes(candidate)
  }
  if (field.kind === 'text') return typeof candidate === 'string' && candidate.length <= (field.maxLength ?? 260)
  return false
}

/** Remember the effective values of a confirmed panel. Returns the memory key. */
export async function rememberPanelValues(panel, options = {}) {
  const key = panelMemoryKey(panel)
  if (!key) return null
  const stored = {}
  for (const field of panel.fields ?? []) {
    if (field.key === 'note' || field.key === 'theme') continue
    const value = panel.values?.[field.key]
    if (!isStorable(value)) continue
    stored[field.key] = value
  }
  if (Object.keys(stored).length === 0) return null
  const memory = await readPanelMemory(options.env)
  memory.entries[key] = stored
  const keys = Object.keys(memory.entries)
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete memory.entries[stale]
  await writePanelMemory(memory, options.env)
  return key
}

/** Overlay remembered values on a fresh panel. Invalid or missing values are skipped. */
export async function applyRememberedConfig(panel, options = {}) {
  if (!panel || !Array.isArray(panel.fields)) return panel
  const key = panelMemoryKey(panel)
  if (!key) return panel
  const memory = await readPanelMemory(options.env)
  const stored = memory.entries[key]
  if (!stored || typeof stored !== 'object') return panel
  const theme = panel.values?.theme
  const values = { ...panel.values }
  let applied = false
  for (const field of panel.fields) {
    if (field.key === 'note' || field.key === 'theme') continue
    const candidate = stored[field.key]
    if (!candidateApplies(field, theme, candidate)) continue
    if (values[field.key] === candidate) continue
    values[field.key] = candidate
    applied = true
  }
  return applied ? { ...panel, values, remembered: true } : panel
}

export async function clearPanelMemory(env = process.env) {
  await rm(panelMemoryFilePath(env), { force: true }).catch(() => {})
}
