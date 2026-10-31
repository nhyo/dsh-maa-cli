import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'

const MEMORY_VERSION = 2
const MAX_ENTRIES = 64
let memoryMutation = Promise.resolve()

export function panelMemoryFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'panel-memory.json')
}

function emptyMemory() {
  return { version: MEMORY_VERSION, entries: {}, lastRoguelikeTheme: '' }
}

function normalizedMemory(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyMemory()
  const entries = parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries) ? parsed.entries : {}
  // v1 already used Roguelike:<theme> keys. Preserve those entries and add the
  // last-theme field lazily; the next confirmed panel writes v2.
  if (parsed.version === 1) return { version: MEMORY_VERSION, entries, lastRoguelikeTheme: '' }
  if (parsed.version !== MEMORY_VERSION) return emptyMemory()
  return {
    version: MEMORY_VERSION,
    entries,
    lastRoguelikeTheme: typeof parsed.lastRoguelikeTheme === 'string' ? parsed.lastRoguelikeTheme : '',
  }
}

export async function readPanelMemory(env = process.env) {
  try { return normalizedMemory(JSON.parse(await readFile(panelMemoryFilePath(env), 'utf8'))) } catch { return emptyMemory() }
}

async function writePanelMemory(memory, env = process.env) {
  const file = panelMemoryFilePath(env)
  await mkdir(path.dirname(file), { recursive: true })
  const payload = `${JSON.stringify({ version: MEMORY_VERSION, entries: memory.entries, lastRoguelikeTheme: memory.lastRoguelikeTheme ?? '' }, null, 2)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, file)
  } catch {
    await writeFile(file, payload, 'utf8').catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function mutatePanelMemory(env, mutate) {
  const operation = memoryMutation.then(async () => {
    const memory = await readPanelMemory(env)
    const value = await mutate(memory)
    await writePanelMemory(memory, env)
    return value
  })
  memoryMutation = operation.catch(() => {})
  return operation
}

export function panelMemoryKey(panel, theme = panel?.values?.theme) {
  if (!panel || !Array.isArray(panel.fields) || panel.fields.length === 0) return ''
  if (panel.type === 'Roguelike') return typeof theme === 'string' && theme !== '' ? `Roguelike:${theme}` : ''
  return typeof panel.type === 'string' && panel.type !== '' ? `Panel:${panel.type}` : ''
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

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

function listItems(candidate) {
  if (Array.isArray(candidate)) return candidate.map(String)
  if (typeof candidate !== 'string') return null
  return candidate === '' ? [] : candidate.split(/[;；]/u).map(value => value.trim()).filter(Boolean)
}

function candidateApplies(field, theme, candidate) {
  if (candidate === undefined || candidate === null) return false
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
    if (candidate === '' && field.required !== true) return true
    return allowedValues(field, theme).some(value => value === candidate)
  }
  if (field.kind === 'multi') {
    if (!Array.isArray(candidate)) return false
    const allowed = allowedValues(field, theme)
    if (candidate.some(value => !allowed.some(option => option === value))) return false
    return field.required !== true || candidate.length > 0
  }
  if (field.kind === 'list') {
    const items = listItems(candidate)
    return items !== null
      && items.length <= (field.maxItems ?? Number.MAX_SAFE_INTEGER)
      && items.every(value => value.length <= (field.maxLength ?? 260))
  }
  if (field.kind === 'text') return typeof candidate === 'string' && candidate.length <= (field.maxLength ?? 260)
  return false
}

function storedPanelValues(panel) {
  const stored = {}
  const theme = panel.type === 'Roguelike' ? panel.values?.theme : ''
  for (const field of panel.fields ?? []) {
    if (field.key === 'note' || field.key === 'theme') continue
    const value = panel.values?.[field.key]
    if (!candidateApplies(field, theme, value)) continue
    stored[field.key] = clone(value)
  }
  return stored
}

/** Save only the effective values from a successfully confirmed panel. */
export async function rememberPanelValues(panel, options = {}) {
  const key = panelMemoryKey(panel)
  if (!key) return null
  const stored = storedPanelValues(panel)
  const env = options.env ?? process.env
  return await mutatePanelMemory(env, memory => {
    memory.entries[key] = stored
    if (panel.type === 'Roguelike') memory.lastRoguelikeTheme = panel.values.theme
    const keys = Object.keys(memory.entries)
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete memory.entries[stale]
    return key
  })
}

function validStoredValues(panel, stored, theme, explicitKeys = new Set()) {
  if (!isPlainObject(stored)) return {}
  const result = {}
  for (const field of panel.fields ?? []) {
    if (field.key === 'note' || field.key === 'theme' || explicitKeys.has(field.key)) continue
    const candidate = stored[field.key]
    if (!candidateApplies(field, theme, candidate)) continue
    result[field.key] = clone(candidate)
  }
  return result
}

function availableThemes(panel) {
  return panel.fields?.find(field => field.key === 'theme')?.options?.map(option => option.value).filter(value => typeof value === 'string') ?? []
}

/** Overlay history on defaults, while preserving parameters explicit in this command. */
export async function applyRememberedConfig(panel, options = {}) {
  if (!panel || !Array.isArray(panel.fields) || panel.fields.length === 0) return panel
  const memory = await readPanelMemory(options.env ?? process.env)
  const explicitKeys = new Set(Array.isArray(options.explicitKeys) ? options.explicitKeys : [])
  let values = { ...panel.values }
  let remembered = false

  if (panel.type === 'Roguelike') {
    const themes = availableThemes(panel)
    if (!explicitKeys.has('theme') && themes.includes(memory.lastRoguelikeTheme)) {
      const themeOption = panel.fields.find(field => field.key === 'theme')?.options?.find(option => option.value === memory.lastRoguelikeTheme)
      values = { ...values, ...(themeOption?.patch ?? {}), theme: memory.lastRoguelikeTheme }
      remembered = true
    }
    const preferenceVariants = {}
    for (const theme of themes) {
      const valid = validStoredValues(panel, memory.entries[`Roguelike:${theme}`], theme)
      if (Object.keys(valid).length > 0) preferenceVariants[theme] = { ...valid, theme }
    }
    const selectedTheme = values.theme
    const selected = validStoredValues(panel, memory.entries[`Roguelike:${selectedTheme}`], selectedTheme, explicitKeys)
    if (Object.keys(selected).length > 0) { values = { ...values, ...selected }; remembered = true }
    return { ...panel, values, ...(remembered ? { remembered: true } : {}), preferenceVariants }
  }

  const stored = validStoredValues(panel, memory.entries[panelMemoryKey(panel)], '', explicitKeys)
  if (Object.keys(stored).length === 0) return panel
  return { ...panel, values: { ...values, ...stored }, remembered: true }
}

export async function clearPanelMemory(env = process.env) {
  await rm(panelMemoryFilePath(env), { force: true }).catch(() => {})
}
