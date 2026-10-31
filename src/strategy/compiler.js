import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ACTION_TYPES = new Set(['Deploy', 'Skill', 'Retreat', 'SpeedUp', 'BulletTime', 'SkillUsage', 'Output', 'SkillDaemon', 'ResetStopwatch', 'SetUnitLocation'])
const DIRECTIONS = new Map([
  ['left', 'Left'], ['左', 'Left'], ['right', 'Right'], ['右', 'Right'],
  ['up', 'Up'], ['上', 'Up'], ['down', 'Down'], ['下', 'Down'], ['none', 'None'], ['无', 'None'],
])
const AUTOPILOT_DIRECTIONS = new Map([['Left', 'left'], ['Right', 'right'], ['Up', 'up'], ['Down', 'down']])
const COPILOT_MARKER = '__DSH_GENERATED_COPILOT__'
const MANIFEST_NAME = 'active-overlay.json'

export function compileStrategyRequest(input) {
  if (!plain(input)) throw new TypeError('strategy request must be an object')
  const unsupported = normalizeUnsupported(input.unsupportedRequirements)
  if (input.kind === 'Roguelike') return compileRoguelikeRequest(input, unsupported)
  if (input.kind === 'Copilot') return compileCopilotRequest(input, unsupported)
  throw new TypeError('strategy kind must be Roguelike or Copilot')
}

export async function previewStrategy(strategy, resourceDir) {
  const result = await previewStrategyDetails(strategy, resourceDir)
  return { supported: result.supported, unsupported: result.unsupported }
}

export async function previewStrategyDetails(strategy, resourceDir) {
  requireAbsolute(resourceDir, 'MAA resource directory')
  const supported = []
  const unsupported = [...strategy.unsupported]
  const changes = []
  if (strategy.kind === 'Roguelike') {
    const result = await compileRoguelikeFiles(strategy, resourceDir, true)
    supported.push(...result.supported)
    unsupported.push(...result.unsupported)
    for (const file of result.files) changes.push({
      kind: 'resource', target: path.relative(resourceDir, file.target).replaceAll('\\', '/'),
      detail: '通过 --user-resource 临时覆盖；执行结束或异常时恢复',
    })
  } else {
    const result = await compileCopilotFile(strategy, resourceDir)
    supported.push(...result.supported)
    unsupported.push(...result.unsupported)
    if (result.document) {
      changes.push({
        kind: 'copilot', target: `${strategy.stageName} Copilot`,
        detail: result.document.actions.map(action => `${action.type}${action.name ? ` ${action.name}` : ''}${action.kills !== undefined ? ` @ ${action.kills}杀` : ''}`).join(' → '),
      })
    }
  }
  if (supported.length === 0) {
    throw new Error(`没有可安全执行的策略。${unsupported.map(item => `${item.request}：${item.reason}`).join('；') || '请求未包含受支持的策略字段。'}`)
  }
  return { supported, unsupported, changes }
}

export async function materializeStrategy(document, strategy, options) {
  const resourceDir = requireAbsolute(options.resourceDir, 'MAA resource directory')
  const configDir = requireAbsolute(options.configDir, 'maa-cli config directory')
  await recoverStrategyOverlay(configDir)
  if (strategy.kind === 'Copilot') {
    const compiled = await compileCopilotFile(strategy, resourceDir)
    if (compiled.supported.length === 0) throw new Error(formatUnsupported(compiled.unsupported))
    const directory = path.join(configDir, 'dsh-strategies')
    const filename = path.join(directory, 'dsh-generated-copilot.json')
    await mkdir(directory, { recursive: true })
    await atomicWrite(filename, `${JSON.stringify(compiled.document, null, 2)}\n`)
    return {
      document: replaceCopilotMarker(document, filename),
      supported: compiled.supported,
      unsupported: [...strategy.unsupported, ...compiled.unsupported],
      restore: async () => {},
    }
  }

  const documentTheme = document.tasks?.find(task => task?.type === 'Roguelike')?.params?.theme
  const effectiveStrategy = documentTheme && validResourceId(documentTheme) ? { ...strategy, theme: documentTheme } : strategy
  const compiled = await compileRoguelikeFiles(effectiveStrategy, resourceDir, true)
  if (compiled.supported.length === 0) throw new Error(formatUnsupported(compiled.unsupported))
  const userResourceRoot = path.join(configDir, 'resource')
  const overlayFiles = compiled.files.map(entry => ({
    target: path.join(userResourceRoot, path.relative(resourceDir, entry.target)),
    content: entry.content,
  }))
  const overlay = await installOverlay(overlayFiles, configDir)
  return {
    document,
    userResource: true,
    supported: compiled.supported,
    unsupported: [...strategy.unsupported, ...compiled.unsupported],
    restore: overlay.restore,
  }
}

// Plugin-generated files that a task reads (custom base schedules, copilot
// jobs downloaded from the MAA copilot site). They live next to the generated
// strategy Copilot file, are referenced through markers in the confirmed plan,
// and are removed again after the run.
export function generatedFileMarker(name) {
  const key = String(name ?? '').toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '')
  if (!key) throw new TypeError('generated file name is required')
  return `__DSH_GENERATED_${key}__`
}

export async function materializeGeneratedFiles(document, files, options) {
  const configDir = requireAbsolute(options.configDir, 'maa-cli config directory')
  if (!Array.isArray(files) || files.length === 0) return { document, restore: async () => {} }
  const directory = path.join(configDir, 'dsh-strategies')
  await mkdir(directory, { recursive: true })
  const paths = new Map()
  for (const file of files) {
    if (!plain(file) || typeof file.marker !== 'string' || !plain(file.content)) throw new Error('生成文件格式无效。')
    const target = path.join(directory, `dsh-generated-${file.marker.replace(/^__DSH_GENERATED_|__$/gu, '').toLowerCase()}.json`)
    await atomicWrite(target, `${JSON.stringify(file.content, null, 2)}\n`)
    paths.set(file.marker, target)
  }
  const clone = structuredClone(document)
  const used = new Set()
  const swap = value => {
    if (typeof value === 'string' && paths.has(value)) { used.add(value); return paths.get(value) }
    if (Array.isArray(value)) return value.map(swap)
    if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item)]))
    return value
  }
  for (const task of clone.tasks ?? []) if (plain(task?.params)) task.params = swap(task.params)
  // A marker left in the plan has no file behind it: refuse to start MAA. A
  // generated file nobody references (the user replaced the path on the
  // panel) is harmless and simply removed after the run.
  const unresolved = JSON.stringify(clone).match(/__DSH_GENERATED_[A-Z0-9_]+__/u)
  if (unresolved && unresolved[0] !== COPILOT_MARKER) throw new Error(`计划引用了不存在的生成文件：${unresolved[0]}`)
  let restored = false
  return {
    document: clone,
    files: [...paths.values()],
    unused: [...paths.keys()].filter(marker => !used.has(marker)),
    restore: async () => {
      if (restored) return
      restored = true
      await Promise.all([...paths.values()].map(target => rm(target, { force: true }).catch(() => {})))
    },
  }
}

export async function recoverStrategyOverlay(configDir) {
  const root = path.join(requireAbsolute(configDir, 'maa-cli config directory'), 'dsh-strategy-overlay')
  const manifestPath = path.join(root, MANIFEST_NAME)
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw new Error(`无法读取上次策略恢复清单：${error.message}`)
  }
  if (!Array.isArray(manifest.files)) throw new Error('策略恢复清单格式无效，请勿继续执行 MAA。')
  for (const entry of manifest.files) {
    requireAbsolute(entry.target, 'overlay target')
    if (entry.existed) {
      requireAbsolute(entry.backup, 'overlay backup')
      await copyFile(entry.backup, entry.target)
    } else {
      await rm(entry.target, { force: true })
    }
  }
  await rm(root, { recursive: true, force: true })
  return true
}

function compileRoguelikeRequest(input, unsupported) {
  const task = plain(input.task) ? input.task : {}
  const theme = requiredText(task.theme, 'Roguelike theme', 32)
  if (!validResourceId(theme)) throw new TypeError(`invalid Roguelike theme resource id: ${theme}`)
  const startsCount = integer(task.startsCount ?? 1, 1, 99999, 'startsCount')
  const step = {
    type: 'Roguelike', theme, startsCount,
    ...(optionalInteger(task.mode, 0, 99999, 'mode') !== undefined ? { mode: task.mode } : {}),
    ...(optionalInteger(task.difficulty, 0, 99, 'difficulty') !== undefined ? { difficulty: task.difficulty } : {}),
    ...(textOrUndefined(task.squad, 32) ? { squad: task.squad.trim() } : {}),
    ...(textOrUndefined(task.coreChar, 32) ? { coreChar: task.coreChar.trim() } : {}),
    ...(textOrUndefined(task.roles, 32) ? { roles: task.roles.trim() } : {}),
    ...(typeof task.useSupport === 'boolean' ? { useSupport: task.useSupport } : {}),
    ...(typeof task.useNonFriendSupport === 'boolean' ? { useNonFriendSupport: task.useNonFriendSupport } : {}),
  }
  const recruitment = plain(input.recruitment) ? {
    prioritize: operatorPreferences(input.recruitment.prioritize, 'prioritize'),
    promote: operatorPreferences(input.recruitment.promote, 'promote'),
    teamComplete: teamConditions(input.recruitment.teamComplete),
  } : null
  const shopping = plain(input.shopping) ? {
    prioritize: textArray(input.shopping.prioritize, 50, 80, 'shopping.prioritize'),
    avoid: textArray(input.shopping.avoid, 50, 80, 'shopping.avoid'),
  } : null
  const encounters = Array.isArray(input.encounters) ? input.encounters.map((entry, index) => ({
    name: requiredText(entry?.name, `encounters[${index}].name`, 80),
    choose: integer(entry?.choose, 1, 20, `encounters[${index}].choose`),
    optionCount: optionalInteger(entry?.optionCount, 1, 20, `encounters[${index}].optionCount`),
  })) : []
  const tactics = Array.isArray(input.tactics) ? input.tactics.map((tactic, index) => roguelikeTactic(tactic, `tactics[${index}]`)) : []
  return { kind: 'Roguelike', theme, step, recruitment, shopping, encounters, tactics, unsupported }
}

function roguelikeTactic(tactic, label) {
  if (!plain(tactic)) throw new TypeError(`${label} must be an object`)
  const result = {
    kind: ['guard_blue', 'block_entrance'].includes(tactic.kind) ? tactic.kind : invalid(`${label}.kind is unsupported`),
    name: requiredText(tactic.name, `${label}.name`, 64),
  }
  if (tactic.stageName !== undefined) result.stageName = requiredText(tactic.stageName, `${label}.stageName`, 96)
  if (tactic.location !== undefined) result.location = point(tactic.location, `${label}.location`)
  if (tactic.direction !== undefined) result.direction = direction(tactic.direction, `${label}.direction`)
  return result
}

function compileCopilotRequest(input, unsupported) {
  const task = plain(input.task) ? input.task : {}
  const stageName = requiredText(task.stageName, 'Copilot stageName', 96)
  const operators = operatorList(input.operators, 'operators')
  const groups = Array.isArray(input.groups) ? input.groups.map((group, index) => ({
    name: requiredText(group?.name, `groups[${index}].name`, 64),
    opers: operatorList(group?.opers, `groups[${index}].opers`),
  })) : []
  const actions = Array.isArray(input.actions) ? input.actions.map((action, index) => copilotAction(action, `actions[${index}]`)) : []
  const tactics = Array.isArray(input.tactics) ? input.tactics.map((tactic, index) => ({
    kind: ['guard_blue', 'block_entrance'].includes(tactic?.kind) ? tactic.kind : invalid(`tactics[${index}].kind is unsupported`),
    name: requiredText(tactic?.name, `tactics[${index}].name`, 64),
    kills: optionalInteger(tactic?.kills, 0, 10000, `tactics[${index}].kills`) ?? 0,
  })) : []
  if (actions.length === 0 && tactics.length === 0) unsupported.push({ request: '战斗动作', reason: '没有提供可执行的部署、技能或撤退动作' })
  return {
    kind: 'Copilot', stageName, formation: task.formation === true,
    operators, groups, actions, tactics, unsupported,
  }
}

async function compileRoguelikeFiles(strategy, resourceDir, includeFiles) {
  const base = path.join(resourceDir, 'roguelike', strategy.theme)
  const files = []
  const supported = [`切换肉鸽主题 ${strategy.theme}`]
  const unsupported = []
  const tactics = Array.isArray(strategy.tactics) ? strategy.tactics : []
  const recruitment = strategy.recruitment && (strategy.recruitment.prioritize.length || strategy.recruitment.promote.length || strategy.recruitment.teamComplete.length)
    ? strategy.recruitment : null
  const registry = recruitment || tactics.length ? await openRecruitmentRegistry(base, resourceDir) : null
  if (recruitment) {
    for (const preference of recruitment.prioritize) {
      const resolved = ensureOperatorGroup(registry, preference.name, { priority: preference.priority, skill: preference.skill })
      if (!resolved) unsupported.push({ request: `优先招募 ${preference.name}`, reason: `${missingOperatorReason(registry)}，未新增不可靠分组` })
      else supported.push(`优先招募 ${preference.name}${resolved.created ? `（新增分组 ${resolved.groupName}）` : ''}`)
    }
    for (const preference of recruitment.promote) {
      const resolved = ensureOperatorGroup(registry, preference.name, { promotePriority: preference.priority })
      if (!resolved) unsupported.push({ request: `优先精二 ${preference.name}`, reason: missingOperatorReason(registry) })
      else supported.push(`优先精二 ${preference.name}${resolved.created ? `（新增分组 ${resolved.groupName}）` : ''}`)
    }
    if (recruitment.teamComplete.length) {
      const groupNames = new Set(registry.groups.map(group => group?.name).filter(Boolean))
      const invalidGroups = recruitment.teamComplete.flatMap(condition => condition.groups.filter(name => !groupNames.has(name)))
      if (invalidGroups.length) unsupported.push({ request: '调整阵容完备条件', reason: `不存在的原生分组：${[...new Set(invalidGroups)].join('、')}` })
      else {
        registry.json.team_complete_condition = recruitment.teamComplete
        registry.dirty = true
        supported.push('调整阵容完备条件')
      }
    }
  }
  if (strategy.shopping && (strategy.shopping.prioritize.length || strategy.shopping.avoid.length)) {
    const target = path.join(base, 'shopping.json')
    const json = await readJson(target, '肉鸽购物策略')
    const priority = Array.isArray(json.priority) ? json.priority : []
    const other = Array.isArray(json.other) ? json.other : []
    for (const name of strategy.shopping.prioritize.slice().reverse()) {
      const found = takeNamed(priority, name) ?? takeNamed(other, name)
      if (!found) unsupported.push({ request: `优先购买 ${name}`, reason: `${strategy.theme} 的购物策略中没有该物品` })
      else { priority.unshift(found); supported.push(`优先购买 ${name}`) }
    }
    for (const name of strategy.shopping.avoid) {
      const found = takeNamed(priority, name)
      if (!found) unsupported.push({ request: `禁买 ${name}`, reason: `${strategy.theme} 的可购物品中没有该物品` })
      else {
        if (Array.isArray(json.other) && !other.some(item => item?.name === name)) other.push(found)
        supported.push(`禁买 ${name}`)
      }
    }
    json.priority = priority
    if (Array.isArray(json.other)) json.other = other
    if (includeFiles) files.push({ target, content: json })
  }
  if (strategy.encounters.length) {
    const { target, json } = await selectEncounterStrategy(base, strategy.step.mode ?? 0)
    const stages = Array.isArray(json.stage) ? json.stage : []
    for (const preference of strategy.encounters) {
      const event = stages.find(item => item?.name === preference.name)
      if (!event) unsupported.push({ request: `事件 ${preference.name} 选择第 ${preference.choose} 项`, reason: `${strategy.theme} 的事件策略中没有该事件` })
      else {
        const optionCount = preference.optionCount ?? event.option_num
        if (!Number.isInteger(optionCount) || preference.choose > optionCount) unsupported.push({ request: `事件 ${preference.name} 选择第 ${preference.choose} 项`, reason: `选项数为 ${optionCount ?? '未知'}` })
        else {
          event.option_num = optionCount
          event.choose = preference.choose
          supported.push(`事件 ${preference.name} 优先第 ${preference.choose} 项`)
        }
      }
    }
    if (includeFiles) files.push({ target, content: json })
  }
  if (tactics.length) {
    for (const tactic of tactics) {
      const label = tactic.kind === 'guard_blue' ? '守蓝门' : '堵门'
      const request = `${label}：${tactic.name}`
      const resolved = ensureOperatorGroup(registry, tactic.name, {})
      if (!resolved) { unsupported.push({ request, reason: `${missingOperatorReason(registry)}，无法写入 deploy_plan` }); continue }
      if (!tactic.stageName) {
        await writeWildcardTactic({ strategy, tactic, label, registry, resolved, base, resourceDir, files, supported, unsupported })
        continue
      }
      if (!tactic.location) { unsupported.push({ request, reason: `缺少部署坐标，无法确定 ${tactic.stageName} 的落点` }); continue }
      if (!tactic.direction) { unsupported.push({ request, reason: '缺少部署朝向（左/右/上/下）' }); continue }
      const facing = AUTOPILOT_DIRECTIONS.get(tactic.direction)
      if (!facing) { unsupported.push({ request, reason: `不支持的部署朝向：${tactic.direction}` }); continue }
      const found = await findAutopilotFile(base, tactic.stageName)
      if (!found) {
        unsupported.push({ request, reason: `${strategy.theme} 没有关卡 ${tactic.stageName} 的原生自动战斗配置，请检查关卡名` })
        continue
      }
      const { target, json } = found
      const plan = Array.isArray(json.deploy_plan) ? json.deploy_plan : (json.deploy_plan = [])
      const duplicated = plan.some(entry => Array.isArray(entry?.location) && entry.location[0] === tactic.location[0] && entry.location[1] === tactic.location[1] && Array.isArray(entry.groups) && entry.groups.includes(resolved.groupName))
      if (!duplicated) {
        plan.push({ groups: [resolved.groupName], location: [...tactic.location], direction: facing })
        files.push({ target, content: json })
      }
      supported.push(`${label}：${tactic.name} @ ${tactic.stageName} [${tactic.location.join(',')}] ${facing}`)
    }
  }
  if (registry?.dirty && includeFiles && !files.some(file => file.target === registry.target)) files.push({ target: registry.target, content: registry.json })
  return { files, supported, unsupported }
}

async function openRecruitmentRegistry(base, resourceDir) {
  const target = path.join(base, 'recruitment.json')
  const json = await readJson(target, '肉鸽招募策略')
  const groups = Array.isArray(json.priority) ? json.priority : (json.priority = [])
  return { target, json, groups, operators: await loadOperatorNames(resourceDir), dirty: false }
}

async function findAutopilotFile(base, stageName) {
  const directory = path.join(base, 'autopilot')
  let directError = null
  try { return { target: path.join(directory, `${stageName}.json`), json: await readJson(path.join(directory, `${stageName}.json`), '肉鸽自动战斗配置') } } catch (error) { directError = error }
  let names
  try { names = await readdir(directory) } catch { throw directError }
  for (const name of names.sort()) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const target = path.join(directory, name)
    let json
    try { json = JSON.parse(await readFile(target, 'utf8')) } catch { continue }
    if (json?.stage_name === stageName) return { target, json }
  }
  return null
}

export async function loadOperatorNames(resourceDir) {
  let data
  try { data = JSON.parse(await readFile(path.join(resourceDir, 'battle_data.json'), 'utf8')) } catch (error) { return null }
  const chars = data?.chars
  if (!chars || typeof chars !== 'object') return null
  const operators = new Map()
  for (const entry of Object.values(chars)) {
    if (!entry || typeof entry !== 'object') continue
    const info = { position: typeof entry.position === 'string' ? entry.position : '', profession: typeof entry.profession === 'string' ? entry.profession : '' }
    for (const key of ['name', 'name_en']) if (typeof entry?.[key] === 'string' && entry[key].trim()) operators.set(entry[key].trim(), info)
  }
  return operators
}

async function listAutopilotStages(base) {
  const directory = path.join(base, 'autopilot')
  let names
  try { names = await readdir(directory) } catch { return [] }
  const stages = []
  for (const name of names.filter(item => item.toLowerCase().endsWith('.json')).sort()) {
    const target = path.join(directory, name)
    let json
    try { json = JSON.parse(await readFile(target, 'utf8')) } catch { continue }
    if (typeof json?.stage_name !== 'string' || !json.stage_name.trim()) continue
    stages.push({ stageName: json.stage_name.trim(), target, json })
  }
  return stages
}

async function loadTileIndex(resourceDir) {
  const directory = path.join(resourceDir, 'Arknights-Tile-Pos')
  let overview
  try { overview = JSON.parse(await readFile(path.join(directory, 'overview.json'), 'utf8')) } catch { return null }
  const entries = Array.isArray(overview) ? overview : Object.values(overview ?? {})
  const index = new Map()
  for (const entry of entries) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const filename = typeof entry?.filename === 'string' ? entry.filename.trim() : ''
    if (!name || !filename) continue
    if (!index.has(name)) index.set(name, filename)
    const normalized = stageNameKey(name)
    if (normalized && !index.has(normalized)) index.set(normalized, filename)
  }
  if (!index.size) return null
  const cache = new Map()
  return async stageName => {
    if (cache.has(stageName)) return cache.get(stageName)
    let map = null
    const filename = index.get(stageName) ?? index.get(stageNameKey(stageName))
    if (filename) {
      try { map = JSON.parse(await readFile(path.join(directory, filename), 'utf8')) } catch { map = null }
    }
    cache.set(stageName, map)
    return map
  }
}

async function writeWildcardTactic(context) {
  const { strategy, tactic, label, registry, resolved, base, resourceDir, files, supported, unsupported } = context
  const request = `${label}：${tactic.name}（全部关卡）`
  const stages = await listAutopilotStages(base)
  if (!stages.length) { unsupported.push({ request, reason: `${strategy.theme} 没有任何原生自动战斗关卡配置` }); return }
  const tiles = await loadTileIndex(resourceDir)
  if (!tiles) { unsupported.push({ request, reason: '缺少 Arknights-Tile-Pos 地图数据，无法为全部关卡自动选点' }); return }
  const position = registry.operators?.get(tactic.name)?.position
  const buildableType = position === 'RANGED' ? 2 : position === 'MELEE' ? 1 : 0
  const atEnd = tactic.kind === 'guard_blue'
  if (tactic.location || tactic.direction) supported.push(`${label}：未指定关卡，已忽略手动坐标与朝向，改为按地图自动选点`)
  const planned = []
  const skipped = []
  for (const stage of stages) {
    const map = await tiles(stage.stageName)
    const route = map ? shortestRoute(map) : null
    const placement = route ? placementFor(route, map, atEnd, buildableType) : null
    const direction = placement ? AUTOPILOT_DIRECTIONS.get(directionBetween(placement.location, placement.facing)) : null
    if (!placement || !direction) { skipped.push(stage.stageName); continue }
    const plan = Array.isArray(stage.json.deploy_plan) ? stage.json.deploy_plan : (stage.json.deploy_plan = [])
    const [x, y] = placement.location
    const duplicated = plan.some(entry => Array.isArray(entry?.location) && entry.location[0] === x && entry.location[1] === y && Array.isArray(entry.groups) && entry.groups.includes(resolved.groupName))
    if (!duplicated) {
      plan.push({ groups: [resolved.groupName], location: [x, y], direction })
      files.push({ target: stage.target, content: stage.json })
    }
    planned.push(`${stage.stageName} [${x},${y}] ${direction}`)
  }
  if (planned.length) supported.push(`${label}：${tactic.name}（全部 ${planned.length} 个原生关卡按地图自动选点）`)
  if (skipped.length) {
    const names = skipped.slice(0, 6).join('、')
    unsupported.push({ request: `${label}：${tactic.name}（其余关卡）`, reason: `${skipped.length} 个关卡缺少地图数据或可部署落点：${names}${skipped.length > 6 ? ' 等' : ''}` })
  }
}

function ensureOperatorGroup(registry, name, options) {
  const existing = findOperators(registry.groups, name)
  if (existing.length) {
    const group = registry.groups.find(item => Array.isArray(item?.opers) && item.opers.some(operator => operator?.name === name))
    for (const operator of existing) {
      if (options.priority !== undefined && operator.recruit_priority !== options.priority) { operator.recruit_priority = options.priority; registry.dirty = true }
      if (options.promotePriority !== undefined && operator.promote_priority !== options.promotePriority) { operator.promote_priority = options.promotePriority; registry.dirty = true }
      if (options.skill !== undefined && operator.skill !== options.skill) { operator.skill = options.skill; registry.dirty = true }
    }
    return { groupName: group?.name ?? name, created: false }
  }
  if (!registry.operators?.has(name)) return null
  const groupName = uniqueGroupName(registry.groups, name)
  registry.groups.unshift({
    name: groupName,
    opers: [{
      name,
      skill: options.skill ?? 1,
      is_key: false,
      is_start: false,
      recruit_priority: options.priority ?? 2000,
      promote_priority: options.promotePriority ?? 2000,
    }],
  })
  registry.dirty = true
  return { groupName, created: true }
}

function uniqueGroupName(groups, name) {
  const used = new Set(groups.map(group => group?.name).filter(Boolean))
  if (!used.has(name)) return name
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${name}（优先${index}）`
    if (!used.has(candidate)) return candidate
  }
  return `${name}（备注）`
}

function missingOperatorReason(registry) {
  return registry?.operators ? 'MAA 干员数据中没有该干员' : '缺少 MAA 的 battle_data.json，无法确认干员真实存在'
}

function stageNameKey(value) {
  return String(value ?? '').replace(/^[\u201c\u201d"「『]+|[\u201c\u201d"」』]+$/gu, '').trim()
}

async function selectEncounterStrategy(base, mode) {
  const directory = path.join(base, 'encounter')
  const names = (await readdir(directory)).filter(name => name.toLowerCase().endsWith('.json')).sort()
  let fallback = null
  for (const name of names) {
    const target = path.join(directory, name)
    const json = await readJson(target, '肉鸽事件策略')
    if (name === 'default.json') fallback = { target, json }
    if (Array.isArray(json.mode) && json.mode.includes(mode)) return { target, json }
  }
  if (fallback) return fallback
  throw new Error(`${base} 没有适用于 mode=${mode} 的事件策略文件`)
}

async function compileCopilotFile(strategy, resourceDir) {
  const supported = []
  const unsupported = []
  const actions = []
  if (strategy.tactics.length) {
    let map
    try { map = await loadStageMap(resourceDir, strategy.stageName) } catch (error) {
      for (const tactic of strategy.tactics) unsupported.push({ request: tactic.kind === 'guard_blue' ? '守蓝门' : '堵门', reason: error.message })
    }
    if (map) {
      const route = shortestRoute(map)
      if (!route) {
        for (const tactic of strategy.tactics) unsupported.push({ request: tactic.kind === 'guard_blue' ? '守蓝门' : '堵门', reason: '地图中无法解析入口到蓝门的可部署路径' })
      } else {
        for (const tactic of strategy.tactics) {
          const atEnd = tactic.kind === 'guard_blue'
          const placement = tacticalPlacement(route, map, atEnd)
          const location = placement?.location
          const facing = placement?.facing
          if (!location || !facing) unsupported.push({ request: atEnd ? '守蓝门' : '堵门', reason: '路径过短，无法选择安全部署格' })
          else {
            actions.push({ type: 'Deploy', name: tactic.name, location, direction: directionBetween(location, facing), kills: tactic.kills })
            supported.push(`${atEnd ? '守蓝门' : '堵门'}：${tactic.name} @ [${location.join(',')}]`)
          }
        }
      }
    }
  }
  actions.push(...strategy.actions)
  if (strategy.actions.length) supported.push(`编译 ${strategy.actions.length} 个有序战斗动作`)
  if (actions.length === 0) return { supported, unsupported, document: null }
  return {
    supported,
    unsupported,
    document: {
      minimum_required: 'v6.18.0',
      stage_name: strategy.stageName,
      opers: strategy.operators,
      groups: strategy.groups,
      actions,
      doc: { title: `DSH 策略：${strategy.stageName}`, details: '由 dsh-maa-cli 根据用户确认的自然语言策略生成' },
    },
  }
}

async function installOverlay(files, configDir) {
  if (files.length === 0) return { restore: async () => {} }
  const root = path.join(configDir, 'dsh-strategy-overlay')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const manifest = { version: 1, id: randomUUID(), files: [] }
  for (let index = 0; index < files.length; index += 1) {
    const entry = files[index]
    let existed = true
    try { await access(entry.target) } catch (error) { if (error?.code === 'ENOENT') existed = false; else throw error }
    const backup = existed ? path.join(root, `${index}.json`) : ''
    if (existed) await copyFile(entry.target, backup)
    manifest.files.push({ target: entry.target, backup, existed })
  }
  await writeFile(path.join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  try {
    for (const entry of files) {
      await mkdir(path.dirname(entry.target), { recursive: true })
      await atomicWrite(entry.target, `${JSON.stringify(entry.content, null, 2)}\n`)
    }
  } catch (error) {
    await recoverStrategyOverlay(configDir)
    throw error
  }
  let restored = false
  return { restore: async () => { if (!restored) { restored = true; await recoverStrategyOverlay(configDir) } } }
}

function replaceCopilotMarker(document, filename) {
  const clone = structuredClone(document)
  const task = clone.tasks?.find(item => item?.type === 'Copilot' && item?.params?.filename === COPILOT_MARKER)
  if (!task) throw new Error('策略计划缺少 Copilot 占位任务。')
  task.params.filename = filename
  return clone
}

async function loadStageMap(resourceDir, stageName) {
  const stages = await readJson(path.join(resourceDir, 'stages.json'), 'MAA 关卡索引')
  const stage = Array.isArray(stages) ? stages.find(item => [item?.code, item?.stageId].includes(stageName)) : null
  const identity = stage?.stageId ?? stageName
  const directory = path.join(resourceDir, 'Arknights-Tile-Pos')
  const names = await readdir(directory)
  const candidates = names.filter(name => name.toLowerCase().endsWith('.json') && !name.includes('#f#') && name.startsWith(`${identity}-`))
  for (const name of candidates) {
    const map = await readJson(path.join(directory, name), 'MAA 地图数据')
    if ([map.code, map.stageId, map.levelId, map.name].includes(stageName) || map.stageId === identity) return map
  }
  throw new Error(`MAA 地图资源中找不到唯一关卡 ${stageName}；请改用明确坐标`)
}

function shortestRoute(map) {
  if (!Array.isArray(map.tiles)) return null
  const starts = []
  const ends = []
  for (let y = 0; y < map.tiles.length; y += 1) for (let x = 0; x < map.tiles[y].length; x += 1) {
    const tile = map.tiles[y][x]
    if (tile?.tileKey === 'tile_forbidden') continue
    if (tile?.isStart) starts.push([x, y])
    if (tile?.isEnd) ends.push([x, y])
  }
  if (!starts.length || !ends.length) return null
  let best = null
  const usable = candidate => candidate.some(([x, y]) => (Number(map.tiles[y]?.[x]?.buildableType) || 0) > 0)
  const better = (candidate, current) => {
    const candidateUsable = usable(candidate) ? 1 : 0
    const currentUsable = usable(current) ? 1 : 0
    if (candidateUsable !== currentUsable) return candidateUsable > currentUsable
    return candidate.length < current.length
  }
  for (const start of starts) {
    const queue = [[start, [start]]]
    const seen = new Set([start.join(',')])
    while (queue.length) {
      const [current, route] = queue.shift()
      if (ends.some(end => equalPoint(end, current))) { if (!best || better(route, best)) best = route; break }
      for (const next of neighbors(current)) {
        const [x, y] = next
        const tile = map.tiles[y]?.[x]
        const key = next.join(',')
        if (!tile || seen.has(key) || !isPassable(tile)) continue
        seen.add(key)
        queue.push([next, [...route, next]])
      }
    }
  }
  return best
}

function tacticalPlacement(route, map, atEnd, buildableType = 1) {
  const indexes = atEnd
    ? Array.from({ length: route.length }, (_, index) => route.length - 1 - index)
    : Array.from({ length: route.length }, (_, index) => index)
  const index = indexes.find(value => {
    const [x, y] = route[value]
    return map.tiles[y]?.[x]?.buildableType === buildableType
  })
  if (!Number.isInteger(index)) return null
  const facingIndex = index > 0 ? index - 1 : index + 1
  if (facingIndex < 0 || !route[facingIndex]) return null
  return { location: route[index], facing: route[facingIndex] }
}

function placementFor(route, map, atEnd, buildableType) {
  if (buildableType === 1) return tacticalPlacement(route, map, atEnd, 1)
  const anchor = atEnd ? route[route.length - 1] : route[0]
  if (!anchor || !Array.isArray(map.tiles)) return null
  let best = null
  for (let y = 0; y < map.tiles.length; y += 1) {
    const row = map.tiles[y]
    if (!Array.isArray(row)) continue
    for (let x = 0; x < row.length; x += 1) {
      const type = Number(row[x]?.buildableType)
      const usable = buildableType === 0 ? (type === 1 || type === 2) : type === buildableType
      if (!usable) continue
      const distance = Math.abs(x - anchor[0]) + Math.abs(y - anchor[1])
      if (!best || distance < best.distance) best = { location: [x, y], distance }
    }
  }
  if (!best) return null
  const start = route[0] ?? anchor
  const facing = equalPoint(best.location, start) ? (route[1] ?? start) : start
  return { location: best.location, facing }
}

function isPassable(tile) {
  if (tile.isStart || tile.isEnd || tile.buildableType === 1) return true
  if (tile.heightType !== 0) return false
  return !['tile_forbidden', 'tile_hole', 'tile_wall'].includes(tile.tileKey)
}

function copilotAction(action, label) {
  if (!plain(action)) throw new TypeError(`${label} must be an object`)
  const type = requiredText(action.type, `${label}.type`, 32)
  if (!ACTION_TYPES.has(type)) throw new TypeError(`${label}.type ${type} is unsupported`)
  const result = { type }
  if (action.name !== undefined) result.name = requiredText(action.name, `${label}.name`, 64)
  if (action.location !== undefined) result.location = point(action.location, `${label}.location`)
  if (action.direction !== undefined) result.direction = direction(action.direction, `${label}.direction`)
  copyInteger(action, result, 'kills', 0, 10000, label)
  copyInteger(action, result, 'costs', 0, 999, label)
  copyInteger(action, result, 'preDelay', 0, 600000, label, 'pre_delay')
  copyInteger(action, result, 'postDelay', 0, 600000, label, 'post_delay')
  copyInteger(action, result, 'timeout', -1, 3600000, label)
  copyInteger(action, result, 'skillUsage', 0, 3, label, 'skill_usage')
  copyInteger(action, result, 'skillTimes', 1, 100, label, 'skill_times')
  if (type === 'Deploy' && (!result.name || !result.location || !result.direction)) throw new TypeError(`${label} Deploy requires name, location, and direction`)
  if (['Skill', 'Retreat', 'SkillUsage', 'SetUnitLocation'].includes(type) && !result.name) throw new TypeError(`${label} ${type} requires name`)
  if (type === 'SetUnitLocation' && !result.location) throw new TypeError(`${label} SetUnitLocation requires location`)
  return result
}

function operatorList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 50) throw new TypeError(`${label} must be an array with at most 50 items`)
  return value.map((operator, index) => {
    const result = { name: requiredText(operator?.name, `${label}[${index}].name`, 64) }
    if (operator.skill !== undefined) result.skill = integer(operator.skill, 0, 3, `${label}[${index}].skill`)
    if (operator.skillUsage !== undefined) result.skill_usage = integer(operator.skillUsage, 0, 3, `${label}[${index}].skillUsage`)
    if (operator.skillTimes !== undefined) result.skill_times = integer(operator.skillTimes, 1, 100, `${label}[${index}].skillTimes`)
    return result
  })
}

function operatorPreferences(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 30) throw new TypeError(`recruitment.${label} must be an array with at most 30 items`)
  return value.map((item, index) => ({
    name: requiredText(item?.name, `recruitment.${label}[${index}].name`, 64),
    priority: optionalInteger(item?.priority, 0, 1000000, `recruitment.${label}[${index}].priority`),
    skill: optionalInteger(item?.skill, 1, 3, `recruitment.${label}[${index}].skill`),
  }))
}

function teamConditions(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw new TypeError('teamComplete must be an array with at most 20 conditions')
  return value.map((condition, index) => {
    const groups = textArray(condition?.groups, 20, 64, `teamComplete[${index}].groups`)
    if (groups.length === 0) throw new TypeError(`teamComplete[${index}].groups cannot be empty`)
    return { groups, threshold: integer(condition?.threshold, 1, groups.length, `teamComplete[${index}].threshold`) }
  })
}

function findOperators(groups, name) { return groups.flatMap(group => Array.isArray(group?.opers) ? group.opers.filter(operator => operator?.name === name) : []) }
function takeNamed(array, name) { const index = array.findIndex(item => item?.name === name); return index < 0 ? null : array.splice(index, 1)[0] }
function formatUnsupported(items) { return `策略没有可安全执行的修改：${items.map(item => `${item.request}（${item.reason}）`).join('；')}` }
function normalizeUnsupported(value) { return Array.isArray(value) ? value.map((item, index) => ({ request: requiredText(item?.request, `unsupportedRequirements[${index}].request`, 160), reason: requiredText(item?.reason, `unsupportedRequirements[${index}].reason`, 240) })) : [] }
async function readJson(filename, label) { try { return JSON.parse(await readFile(filename, 'utf8')) } catch (error) { throw new Error(`${label}无法读取：${filename}：${error.message}`) } }
async function atomicWrite(filename, content) { const temporary = `${filename}.dsh-tmp-${process.pid}-${randomUUID()}`; await writeFile(temporary, content, 'utf8'); await rename(temporary, filename) }
function neighbors([x, y]) { return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] }
function equalPoint(a, b) { return a[0] === b[0] && a[1] === b[1] }
function directionBetween(from, to) { const dx = to[0] - from[0]; const dy = to[1] - from[1]; if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'Left' : 'Right'; return dy < 0 ? 'Down' : 'Up' }
function point(value, label) { if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${label} must be [x, y]`); return value.map((item, index) => integer(item, 0, 99, `${label}[${index}]`)) }
function direction(value, label) { const result = DIRECTIONS.get(String(value).trim().toLowerCase()) ?? DIRECTIONS.get(String(value).trim()); if (!result) throw new TypeError(`${label} must be Left/Right/Up/Down/None`); return result }
function copyInteger(source, target, sourceKey, min, max, label, targetKey = sourceKey) { if (source[sourceKey] !== undefined) target[targetKey] = integer(source[sourceKey], min, max, `${label}.${sourceKey}`) }
function textArray(value, maxItems, maxLength, label) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${label} must be an array with at most ${maxItems} items`); return [...new Set(value.map((item, index) => requiredText(item, `${label}[${index}]`, maxLength)))] }
function requiredText(value, label, maxLength) { if (typeof value !== 'string' || value.trim() === '' || value.trim().length > maxLength || /[\r\n\0]/u.test(value)) throw new TypeError(`${label} is invalid`); return value.trim() }
function textOrUndefined(value, maxLength) { if (value === undefined) return undefined; return requiredText(value, 'text', maxLength) }
function integer(value, min, max, label) { if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${label} must be an integer from ${min} to ${max}`); return value }
function optionalInteger(value, min, max, label) { return value === undefined ? undefined : integer(value, min, max, label) }
function requireAbsolute(value, label) { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`); return path.resolve(value) }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function invalid(message) { throw new TypeError(message) }
function validResourceId(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(value) }

export const GENERATED_COPILOT_MARKER = COPILOT_MARKER
