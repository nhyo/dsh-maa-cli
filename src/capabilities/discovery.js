import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'

const FORMAT_VERSION = 1
const CACHE_NAME = 'maa-capabilities.json'
const memory = new Map()

// MaaCore does not ship a machine-readable task schema in the Windows bundle.
// Keep that non-discoverable protocol surface in one version adapter; resource
// data discovered below always takes precedence where it is authoritative.
const THEME_ADAPTERS = {
  Phantom: { label: '傀影与猩红孤钻', difficultyMax: 0, features: {}, defaults: { difficulty: 0, squad: '指挥分队', roles: '取长补短', coreChar: '丰川祥子', useSupport: false }, modes: [0, 1, 4, 6, 7] },
  Mizuki: { label: '水月与深蓝之树', difficultyMax: 15, features: { stopAtFinalBoss: true, refreshTraderWithDice: true }, defaults: { difficulty: 3, squad: '以人为本分队', roles: '稳扎稳打', coreChar: '维什戴尔', useSupport: true }, modes: [0, 1, 4, 6, 7] },
  Sami: { label: '探索者的银凇止境', difficultyMax: 15, features: { stopAtFinalBoss: true, foldartal: true }, defaults: { difficulty: 4, squad: '特训分队', roles: '稳扎稳打', coreChar: '维什戴尔', useSupport: true }, modes: [0, 1, 4, 5, 6, 7] },
  Sarkaz: { label: '萨卡兹的无终奇语', difficultyMax: 15, features: { stopAtFinalBoss: true }, defaults: { difficulty: 4, squad: '蓝图测绘分队', roles: '稳扎稳打', coreChar: '维什戴尔', useSupport: true }, modes: [0, 1, 4, 6, 7, 10001] },
  JieGarden: { label: '岁的界园志异', difficultyMax: 15, features: { stopAtFinalBoss: true }, defaults: { difficulty: 3, squad: '指挥分队', roles: '稳扎稳打', coreChar: '维什戴尔', useSupport: true }, modes: [0, 1, 4, 6, 7, 20001] },
  BlackFlow: { label: '黑流树海', difficultyMax: 16, minimumCore: '6.20.0', features: { stopAtFinalBoss: true }, defaults: { difficulty: 0, squad: '特勤分队', roles: '稳扎稳打', coreChar: '机械师', useSupport: false }, modes: [0, 1, 4, 6, 7, 30001] },
}

const MODE_LABELS = {
  0: '刷分/奖励点数', 1: '刷源石锭', 4: '凹开局', 5: '刷坍缩范式',
  6: '刷月度小队', 7: '刷深入调查', 10001: '快速过第一层',
  20001: '刷常乐节点', 30001: '刷襁褓动物',
}

const SQUAD_ADAPTER = [
  '指挥分队', '突击战术分队', '堡垒战术分队', '远程战术分队', '破坏战术分队',
  '生活至上分队', '点刺成锭分队', '蓝图测绘分队', '以人为本分队', '心胜于物分队',
  '特训分队', '特勤分队', '高规格分队', '天师府分队', '司岁台分队', '魂灵护送分队',
  '本源研修分队', '博闻广记分队', '代理人分队', '地面突破分队', '高台突破分队',
  '地质调查分队', '多边贸易分队', '后勤分队', '花团锦簇分队', '集群分队',
  '开拓者分队', '科学主义分队', '矛头分队', '拟态学者分队', '棋行险着分队',
  '商贾分队', '岁影回音分队', '踏足遍历分队', '团结阵线分队', '文明开化分队',
  '物尽其用分队', '研究分队', '异想天开分队', '因地制宜分队', '永恒狩猎分队',
  '游客分队', '知学分队', '专业人士分队',
]

const ROLE_ADAPTER = ['取长补短', '稳扎稳打', '坚不可摧']
const THEME_ALIASES = {
  傀影: 'Phantom', 傀影与猩红孤钻: 'Phantom', 水月: 'Mizuki', 水月与深蓝之树: 'Mizuki',
  萨米: 'Sami', 探索者的银凇止境: 'Sami', 萨卡兹: 'Sarkaz', 萨卡兹的无终奇语: 'Sarkaz',
  界园: 'JieGarden', 岁的界园志异: 'JieGarden', 黑流树海: 'BlackFlow',
}

export function capabilityCachePath(env = process.env) {
  return path.join(stateDirectory(env), CACHE_NAME)
}

export function fallbackCapabilities(compatibility = { cliVersion: '0.0.0', coreVersion: '0.0.0' }) {
  const themes = Object.entries(THEME_ADAPTERS).map(([id, adapter]) => themeFromAdapter(id, adapter))
  return descriptor(compatibility, '', 'adapter', themes, { stages: [], stageCount: 0 })
}

export async function discoverMaaCapabilities(options) {
  const resourceDir = requireAbsolute(options.resourceDir, 'MAA resource directory')
  const compatibility = normalizeCompatibility(options.compatibility)
  const env = options.env ?? process.env
  const signature = await resourceSignature(resourceDir, compatibility)
  const key = `${resourceDir.toLowerCase()}\0${signature}`
  if (!options.force && memory.has(key)) return structuredClone(memory.get(key))
  try {
    const value = await scanCapabilities(resourceDir, compatibility, signature)
    await writeCache(value, env)
    memory.clear()
    memory.set(key, value)
    return structuredClone(value)
  } catch (error) {
    const cached = await readCache(env)
    if (cached) return { ...cached, stale: true, warning: `能力重新发现失败，沿用上次已验证缓存：${message(error)}` }
    const fallback = fallbackCapabilities(compatibility)
    return { ...fallback, stale: true, warning: `能力发现失败，使用内置协议适配：${message(error)}` }
  }
}

async function scanCapabilities(resourceDir, compatibility, signature) {
  const rogueRoot = path.join(resourceDir, 'roguelike')
  const entries = await readdir(rogueRoot, { withFileTypes: true })
  const themeIds = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(themeOrder)
  if (themeIds.length === 0) throw new Error('MAA roguelike 资源中没有主题目录')
  const themes = []
  for (const id of themeIds) themes.push(await scanTheme(resourceDir, id, compatibility))
  const stages = await discoverStages(resourceDir)
  return descriptor(compatibility, signature, 'resource', themes, { stages, stageCount: stages.length })
}

async function scanTheme(resourceDir, id, compatibility) {
  const root = path.join(resourceDir, 'roguelike', id)
  const adapter = THEME_ADAPTERS[id] ?? { label: id, difficultyMax: 0, defaults: { difficulty: 0, squad: '', roles: '', coreChar: '', useSupport: false }, modes: [] }
  const recruitment = await optionalJson(path.join(root, 'recruitment.json'))
  const shopping = await optionalJson(path.join(root, 'shopping.json'))
  const strategy = await optionalJson(path.join(root, 'strategy.json'))
  const taskGraph = await optionalJson(path.join(resourceDir, 'tasks', 'Roguelike', `${id}.json`))
  const encounters = await discoverEncounters(path.join(root, 'encounter'))
  const operators = unique(collectOperators(recruitment))
  const groups = unique(Array.isArray(recruitment?.priority) ? recruitment.priority.map(item => item?.name).filter(text) : [])
  const collectibles = unique(collectNames(shopping))
  const referenced = collectStrategyStartValues(strategy)
  const discoveredModes = taskGraph ? Object.keys(taskGraph).flatMap(key => {
    const match = key.match(new RegExp(`^${escapeRegExp(id)}@Roguelike@StrategyChange_mode(\\d+)(?:$|-)`, 'u'))
    return match && !key.includes('NOT_IN_USE') ? [Number(match[1])] : []
  }) : []
  // Some modes are implemented directly in Core and leave no StrategyChange
  // node in the resource graph (notably current BlackFlow modes).
  const modes = uniqueNumbers([...discoveredModes, ...adapter.modes]).map(value => ({ value, label: MODE_LABELS[value] ?? `mode ${value}` }))
  const maxDifficulty = adaptedDifficultyMax(adapter, compatibility)
  const defaults = normalizeDefaults(adapter.defaults, { operators, squads: referenced.squads, roles: referenced.roles })
  return {
    id, label: adapter.label ?? id, defaults, features: { ...(adapter.features ?? {}) },
    difficulties: Array.from({ length: maxDifficulty + 1 }, (_, value) => value), modes,
    squads: unique([defaults.squad, ...referenced.squads, ...SQUAD_ADAPTER].filter(text)),
    roles: unique([defaults.roles, ...referenced.roles, ...ROLE_ADAPTER].filter(text)),
    operators: unique([defaults.coreChar, ...operators].filter(text)), groups, collectibles, encounters,
    resources: {
      recruitment: recruitment !== null, shopping: shopping !== null,
      strategy: strategy !== null, encounterFiles: encounters.files,
    },
  }
}

function descriptor(compatibility, signature, source, themes, maps) {
  return {
    version: FORMAT_VERSION, discoveredAt: new Date().toISOString(), signature, source, stale: false,
    compatibility, roguelike: { themes }, maps,
  }
}

function themeFromAdapter(id, adapter) {
  return {
    id, label: adapter.label, defaults: { ...adapter.defaults }, features: { ...(adapter.features ?? {}) },
    difficulties: Array.from({ length: adapter.difficultyMax + 1 }, (_, value) => value),
    modes: adapter.modes.map(value => ({ value, label: MODE_LABELS[value] ?? `mode ${value}` })),
    squads: unique([adapter.defaults.squad, ...SQUAD_ADAPTER].filter(text)),
    roles: unique([adapter.defaults.roles, ...ROLE_ADAPTER].filter(text)),
    operators: adapter.defaults.coreChar ? [adapter.defaults.coreChar] : [], groups: [], collectibles: [],
    encounters: { names: [], files: [] }, resources: { recruitment: false, shopping: false, strategy: false, encounterFiles: [] },
  }
}

export function roguelikeThemeIds(capabilities) {
  return (capabilities?.roguelike?.themes ?? []).map(theme => theme.id)
}

export function findRoguelikeTheme(capabilities, id) {
  return (capabilities?.roguelike?.themes ?? []).find(theme => theme.id === id) ?? null
}

export function resolveRoguelikeThemeId(capabilities, input) {
  const value = String(input ?? '').trim()
  const direct = findRoguelikeTheme(capabilities, value)
  if (direct) return direct.id
  const byLabel = (capabilities?.roguelike?.themes ?? []).find(theme => theme.label === value)
  if (byLabel) return byLabel.id
  const alias = THEME_ALIASES[value]
  return alias && findRoguelikeTheme(capabilities, alias) ? alias : ''
}

async function resourceSignature(resourceDir, compatibility) {
  const targets = [path.join(resourceDir, 'roguelike'), path.join(resourceDir, 'tasks', 'Roguelike'), path.join(resourceDir, 'stages.json')]
  const parts = [`cli=${compatibility.cliVersion}`, `core=${compatibility.coreVersion}`]
  for (const target of targets) {
    try {
      const info = await stat(target)
      parts.push(`${path.relative(resourceDir, target)}:${info.size}:${info.mtimeMs}`)
      if (info.isDirectory()) {
        const children = await readdir(target, { withFileTypes: true })
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          const childPath = path.join(target, child.name)
          const childInfo = await stat(childPath)
          parts.push(`${path.relative(resourceDir, childPath)}:${childInfo.size}:${childInfo.mtimeMs}`)
          if (target === path.join(resourceDir, 'roguelike') && child.isDirectory()) {
            for (const name of ['recruitment.json', 'shopping.json', 'strategy.json']) {
              const nested = path.join(childPath, name)
              try { const nestedInfo = await stat(nested); parts.push(`${path.relative(resourceDir, nested)}:${nestedInfo.size}:${nestedInfo.mtimeMs}`) } catch (error) { if (error?.code !== 'ENOENT') throw error }
            }
            const encounter = path.join(childPath, 'encounter')
            try {
              const names = await readdir(encounter)
              for (const name of names.sort()) {
                const nested = path.join(encounter, name)
                const nestedInfo = await stat(nested)
                parts.push(`${path.relative(resourceDir, nested)}:${nestedInfo.size}:${nestedInfo.mtimeMs}`)
              }
            } catch (error) { if (error?.code !== 'ENOENT') throw error }
          }
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      parts.push(`${path.relative(resourceDir, target)}:missing`)
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

async function discoverStages(resourceDir) {
  const data = await optionalJson(path.join(resourceDir, 'stages.json'))
  if (!Array.isArray(data)) return []
  return unique(data.flatMap(item => [item?.code, item?.stageId]).filter(text)).sort()
}

async function discoverEncounters(directory) {
  try {
    const files = (await readdir(directory)).filter(name => name.toLowerCase().endsWith('.json')).sort()
    const names = []
    for (const file of files) names.push(...collectNames(await optionalJson(path.join(directory, file))))
    return { files, names: unique(names) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { files: [], names: [] }
    throw error
  }
}

function collectOperators(recruitment) {
  if (!recruitment || !Array.isArray(recruitment.priority)) return []
  return recruitment.priority.flatMap(group => Array.isArray(group?.opers) ? group.opers.map(item => item?.name).filter(text) : [])
}

function collectNames(value) {
  const result = []
  const visit = current => {
    if (Array.isArray(current)) { for (const item of current) visit(item); return }
    if (!current || typeof current !== 'object') return
    if (text(current.name)) result.push(current.name)
    for (const nested of Object.values(current)) visit(nested)
  }
  visit(value)
  return result
}

function collectStrategyStartValues(strategy) {
  const values = []
  const visit = current => {
    if (Array.isArray(current)) { for (const item of current) visit(item); return }
    if (!current || typeof current !== 'object') return
    if (current.fact === 'start_squad' && current.op === 'eq' && text(current.value)) values.push(['squad', current.value])
    if (current.fact === 'start_roles' && current.op === 'eq' && text(current.value)) values.push(['role', current.value])
    for (const nested of Object.values(current)) visit(nested)
  }
  visit(strategy)
  return { squads: unique(values.filter(([kind]) => kind === 'squad').map(([, value]) => value)), roles: unique(values.filter(([kind]) => kind === 'role').map(([, value]) => value)) }
}

function adaptedDifficultyMax(adapter, compatibility) {
  if (adapter.minimumCore && compareVersions(compatibility.coreVersion, adapter.minimumCore) < 0) return 0
  return adapter.difficultyMax ?? 0
}

function normalizeDefaults(defaults, discovered) {
  return {
    difficulty: Number.isInteger(defaults?.difficulty) ? defaults.difficulty : 0,
    squad: defaults?.squad || discovered.squads[0] || '', roles: defaults?.roles || discovered.roles[0] || '',
    coreChar: defaults?.coreChar || discovered.operators[0] || '', useSupport: defaults?.useSupport === true,
  }
}

async function readCache(env) {
  try {
    const value = JSON.parse(await readFile(capabilityCachePath(env), 'utf8'))
    return value?.version === FORMAT_VERSION && Array.isArray(value?.roguelike?.themes) ? value : null
  } catch { return null }
}

async function writeCache(value, env) {
  const file = capabilityCachePath(env)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try { await rename(temporary, file) } catch (error) { await rm(temporary, { force: true }); throw error }
}

async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') return null; throw new Error(`${file}: ${error.message}`) }
}

function themeOrder(a, b) {
  const order = Object.keys(THEME_ADAPTERS)
  const left = order.indexOf(a); const right = order.indexOf(b)
  return (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right) || a.localeCompare(b)
}
function normalizeCompatibility(value) { return { cliVersion: version(value?.cliVersion), coreVersion: version(value?.coreVersion) } }
function version(value) { const result = String(value ?? ''); if (!/^\d+\.\d+\.\d+$/u.test(result)) throw new TypeError('MAA compatibility version is invalid'); return result }
function compareVersions(a, b) { const left = version(a).split('.').map(Number); const right = version(b).split('.').map(Number); for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i]; return 0 }
function unique(values) { return [...new Set(values)] }
function uniqueNumbers(values) { return [...new Set(values.filter(Number.isInteger))].sort((a, b) => a - b) }
function text(value) { return typeof value === 'string' && value.trim() !== '' }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }
function message(error) { return error instanceof Error ? error.message : String(error) }
function requireAbsolute(value, label) { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`); return path.resolve(value) }
