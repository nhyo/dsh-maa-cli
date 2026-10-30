import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ACTION_TYPES = new Set(['Deploy', 'Skill', 'Retreat', 'SpeedUp', 'BulletTime', 'SkillUsage', 'Output', 'SkillDaemon', 'ResetStopwatch', 'SetUnitLocation'])
const DIRECTIONS = new Map([
  ['left', 'Left'], ['左', 'Left'], ['right', 'Right'], ['右', 'Right'],
  ['up', 'Up'], ['上', 'Up'], ['down', 'Down'], ['下', 'Down'], ['none', 'None'], ['无', 'None'],
])
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
  return { kind: 'Roguelike', theme, step, recruitment, shopping, encounters, unsupported }
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
  if (strategy.recruitment && (strategy.recruitment.prioritize.length || strategy.recruitment.promote.length || strategy.recruitment.teamComplete.length)) {
    const target = path.join(base, 'recruitment.json')
    const json = await readJson(target, '肉鸽招募策略')
    const groups = Array.isArray(json.priority) ? json.priority : []
    const groupNames = new Set(groups.map(group => group?.name).filter(Boolean))
    for (const preference of strategy.recruitment.prioritize) {
      const matched = findOperators(groups, preference.name)
      if (matched.length === 0) unsupported.push({ request: `优先招募 ${preference.name}`, reason: `${strategy.theme} 的招募策略中没有该干员，未新增不可靠分组` })
      else {
        for (const operator of matched) {
          operator.recruit_priority = preference.priority ?? 2000
          if (preference.skill !== undefined) operator.skill = preference.skill
        }
        supported.push(`优先招募 ${preference.name}`)
      }
    }
    for (const preference of strategy.recruitment.promote) {
      const matched = findOperators(groups, preference.name)
      if (matched.length === 0) unsupported.push({ request: `优先精二 ${preference.name}`, reason: `${strategy.theme} 的招募策略中没有该干员` })
      else {
        for (const operator of matched) operator.promote_priority = preference.priority ?? 2000
        supported.push(`优先精二 ${preference.name}`)
      }
    }
    if (strategy.recruitment.teamComplete.length) {
      const invalidGroups = strategy.recruitment.teamComplete.flatMap(condition => condition.groups.filter(name => !groupNames.has(name)))
      if (invalidGroups.length) unsupported.push({ request: '调整阵容完备条件', reason: `不存在的原生分组：${[...new Set(invalidGroups)].join('、')}` })
      else {
        json.team_complete_condition = strategy.recruitment.teamComplete
        supported.push('调整阵容完备条件')
      }
    }
    if (includeFiles) files.push({ target, content: json })
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
  return { files, supported, unsupported }
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
    if (tile?.isStart) starts.push([x, y])
    if (tile?.isEnd) ends.push([x, y])
  }
  let best = null
  for (const start of starts) {
    const queue = [[start, [start]]]
    const seen = new Set([start.join(',')])
    while (queue.length) {
      const [current, route] = queue.shift()
      if (ends.some(end => equalPoint(end, current))) { if (!best || route.length < best.length) best = route; break }
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

function tacticalPlacement(route, map, atEnd) {
  const indexes = atEnd
    ? Array.from({ length: route.length }, (_, index) => route.length - 1 - index)
    : Array.from({ length: route.length }, (_, index) => index)
  const index = indexes.find(value => {
    const [x, y] = route[value]
    return map.tiles[y]?.[x]?.buildableType === 1
  })
  if (!Number.isInteger(index)) return null
  const facingIndex = index - 1
  if (facingIndex < 0 || !route[facingIndex]) return null
  return { location: route[index], facing: route[facingIndex] }
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
