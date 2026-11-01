import { actionArguments, isRuntimePath, queryArguments, resolveMaaCliPath, runMaa, startMaa } from './runtime/runner.js'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { buildTaskDocument, GENERATED_TASK_NAME, summarizePlan, writeGeneratedTask } from './commands/planner.js'
import { assertPlanCodeOpen, cancelPendingPlan, consumePlanFromHumanGesture, peekPendingPlan, preparePendingPlan, recordPlanRun, updatePendingPlan } from './commands/confirmation.js'
import { parseLocalMaaCommand } from './commands/local-command.js'
import { activeRun, addRunCheckpoint, beginRun, clearRunStopping, describeRunState, finishRun, getRun, isProcessAlive, markRunStopping, readRunState, reapGeneratedTaskProcesses, setRunProcess, stopRun, updateRunRecovery } from './commands/run-state.js'
import { applyRuntimeInstruction, completeTriggeredInstructions, parseMaaCallbackLine, processMaaCallback, recruitNotices, startLogTail } from './commands/runtime-instructions.js'
import { callbackCheckpoint, decideRecovery, diagnoseExecutionFailure, isExecutionFailure, MAX_RECOVERY_RETRIES } from './agent/recovery-manager.js'
import { createGoal, getGoal, listGoals, planGoal, trainingRequirements, updateGoal } from './agent/goal-manager.js'
import { applyDropRates, applyJointPlan, loadPlanningData, planWithArkPlanner, readPlanningData, weeklyStageOpen, weeklyStageSchedule } from './agent/planning-data.js'
import {
  auditInterruptedWorkflows, createWorkflowExecution, deleteWorkflowPreset, getWorkflowExecution,
  getWorkflowPreset, listWorkflowPresets, saveWorkflowPreset, updateWorkflowExecution, workflowDocument,
} from './agent/workflow-manager.js'
import { applyTaskPanelOverrides, readOnlyPlanPanel, resolveItemId, taskPanelFromDocument } from './commands/task-panel.js'
import { applyRememberedConfig, rememberPanelValues } from './commands/panel-memory.js'
import { discoverMaaCapabilities } from './capabilities/discovery.js'
import { formatReport, runDoctor } from './runtime/doctor.js'
import { prepareRuntimeDirectories } from './runtime/preflight.js'
import { checkEmulator, emulatorErrorMessage } from './runtime/emulator.js'
import { bootstrapRuntime, exists, formatRuntimeReport, inspectRuntime, maybeAutoUpdateRuntime, updateManifest, updateRuntime } from './runtime/runtime.js'
import {
  formatOperatorBoxScanResult,
  parseCompletedOperatorBox,
  queryOperatorBox,
  readOperatorBox,
  saveOperatorBox,
  stripOperBoxCallbacks,
} from './operators/operator-box.js'
import { formatDepotScanResult, loadItemIndex, parseCompletedDepot, queryDepot, readDepot, saveDepot, stripDepotCallbacks } from './operators/depot.js'
import { buildTrainingAdvice, fetchCommunityRanking, formatTrainingAdvice, loadOperatorMetadata } from './operators/training-advice.js'
import {
  compileStrategyRequest,
  GENERATED_COPILOT_MARKER,
  assertNoGeneratedMarkers,
  generatedFileMarker,
  loadOperatorNames,
  materializeGeneratedFiles,
  materializeStrategy,
  previewStrategy,
  previewStrategyDetails,
  recoverStrategyOverlay,
} from './strategy/compiler.js'
import {
  applyStrategyMemory, deleteStrategyMemory, listStrategyMemory, parseMaaCompatibility,
  rememberPlanStrategies, setStrategyMemoryEnabled,
} from './strategy/memory.js'
import { noteModelPrompt, parseStrategyNote } from './strategy/note.js'
import { compileInfrastPlan, deleteInfrastPlan, describeInfrastPlan, listSavedInfrastPlans, ownershipWarnings, saveInfrastPlan } from './strategy/infrast-plan.js'
import { formatCopilotCandidate, getCopilot, rankCopilots, searchCopilots } from './strategy/copilot-site.js'

export const name = 'maa-cli-tools'
export const inject = ['tools', 'commands']

const BASE_RESULT_PROPERTIES = {
  command: { type: 'string' }, exitCode: { type: 'integer' }, terminationSignal: { type: 'string' },
  stdout: { type: 'string' }, stderr: { type: 'string' },
}
const BASE_REQUIRED = Object.keys(BASE_RESULT_PROPERTIES)
const MEMORY_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reused', 'stored', 'rejected', 'categories'],
  properties: {
    reused: { type: 'integer' }, stored: { type: 'integer' }, rejected: { type: 'integer' },
    categories: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
  },
}
const RESULT_SCHEMA = { type: 'object', additionalProperties: false, required: BASE_REQUIRED, properties: BASE_RESULT_PROPERTIES }
const PLAN_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [...BASE_REQUIRED, 'planFile', 'planJson', 'planSummary'],
  properties: { ...BASE_RESULT_PROPERTIES, planFile: { type: 'string' }, planJson: { type: 'string' }, planSummary: { type: 'string' } },
}
const PREPARE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['purpose', 'planJson', 'planSummary', 'confirmationCode', 'confirmationPhrase', 'expiresAt', 'memory'],
  properties: {
    purpose: { type: 'string' }, planJson: { type: 'string' }, planSummary: { type: 'string' },
    confirmationCode: { type: 'string' }, confirmationPhrase: { type: 'string' }, expiresAt: { type: 'string' },
    memory: MEMORY_RESULT_SCHEMA,
  },
}
const STRATEGY_PREPARE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['purpose', 'planJson', 'planSummary', 'confirmationCode', 'confirmationPhrase', 'expiresAt', 'supported', 'unsupported', 'memory'],
  properties: {
    ...PREPARE_RESULT_SCHEMA.properties,
    supported: { type: 'array', items: { type: 'string' } },
    unsupported: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['request', 'reason'],
        properties: { request: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
}
const NOTE_PREPARE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'note'],
  properties: {
    status: { type: 'string', enum: ['ready', 'needs_model'] },
    note: { type: 'string' },
    purpose: { type: 'string' }, planJson: { type: 'string' }, planSummary: { type: 'string' },
    confirmationCode: { type: 'string' }, confirmationPhrase: { type: 'string' }, expiresAt: { type: 'string' },
    supported: { type: 'array', items: { type: 'string' } },
    unsupported: STRATEGY_PREPARE_RESULT_SCHEMA.properties.unsupported,
    memory: MEMORY_RESULT_SCHEMA,
    recognized: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
    modelPrompt: { type: 'string' },
  },
}
const DOCTOR_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'headline', 'failed', 'warned', 'checks'],
  properties: {
    ok: { type: 'boolean' }, headline: { type: 'string' },
    failed: { type: 'array', items: { type: 'string' } },
    warned: { type: 'array', items: { type: 'string' } },
    checks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'title', 'status', 'detail'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'warn', 'fail'] },
          detail: { type: 'string' }, hint: { type: 'string' },
        },
      },
    },
  },
}

const RUNTIME_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['action', 'installed', 'summary', 'steps'],
  properties: {
    action: { type: 'string' },
    installed: { type: 'boolean' },
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'detail'],
        properties: { id: { type: 'string' }, detail: { type: 'string' } },
      },
    },
  },
}

const OPERATOR_PROPERTIES = {
  id: { type: 'string' }, name: { type: 'string' }, rarity: { type: 'integer' },
  elite: { type: 'integer' }, level: { type: 'integer' }, potential: { type: 'integer' },
}
const OPERATOR_BOX_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['available', 'scannedAt', 'ageSeconds', 'totalOwned', 'matched', 'truncated', 'operators', 'summary'],
  properties: {
    available: { type: 'boolean' }, scannedAt: { type: 'string' }, ageSeconds: { type: 'integer' },
    totalOwned: { type: 'integer' }, matched: { type: 'integer' }, truncated: { type: 'boolean' },
    operators: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: Object.keys(OPERATOR_PROPERTIES), properties: OPERATOR_PROPERTIES },
    },
    summary: { type: 'string' },
  },
}

const TRAINING_ADVICE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'scannedAt', 'summary'],
  properties: {
    status: { type: 'string', enum: ['needs_scan', 'needs_choice', 'ready', 'source_error'] },
    scannedAt: { type: 'string' }, summary: { type: 'string' }, policy: { type: 'string' }, strategyUpdate: { type: 'string' },
    recommendations: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'profession', 'professionName', 'tier', 'overallRank', 'professionRank', 'coverageBoost', 'elite', 'level', 'reasons'],
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, profession: { type: 'string' }, professionName: { type: 'string' }, tier: { type: 'string' },
          overallRank: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, professionRank: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          coverageBoost: { type: 'boolean' }, elite: { type: 'integer' }, level: { type: 'integer' },
          reasons: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    coverage: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['profession', 'professionName', 'ownedCount', 'usableCount', 'shortage'],
        properties: {
          profession: { type: 'string' }, professionName: { type: 'string' }, ownedCount: { type: 'integer' }, usableCount: { type: 'integer' }, shortage: { type: 'boolean' },
        },
      },
    },
    source: {
      type: 'object', additionalProperties: false,
      required: ['name', 'url', 'topicId', 'topicTitle', 'topicClosedAt', 'voteCount', 'retrievedAt'],
      properties: {
        name: { type: 'string' }, url: { type: 'string' }, topicId: { type: 'string' }, topicTitle: { type: 'string' },
        topicClosedAt: { type: 'string' }, voteCount: { type: 'integer' }, retrievedAt: { type: 'string' },
      },
    },
  },
}

const AGENT_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'goalId', 'workflowId', 'confirmationCode', 'confirmationPhrase', 'expiresAt', 'data'],
  properties: {
    status: { type: 'string' }, summary: { type: 'string' }, goalId: { type: 'string' }, workflowId: { type: 'string' },
    confirmationCode: { type: 'string' }, confirmationPhrase: { type: 'string' }, expiresAt: { type: 'string' }, data: { type: 'string' },
  },
}

const MISSING_CLI_HINT = '找不到 maa-cli。可以执行 maa_runtime 的 install 动作：插件会自动下载一套私有运行时（maa-cli + MaaCore + 资源，约 520–630 MB），之后无需在系统里安装 MAA。'
let runtimeBootstrapPromise = null

async function requireMaaCli() {
  const cli = resolveMaaCliPath()
  if (!(await exists(cli))) throw new Error(`${MISSING_CLI_HINT}（当前路径：${cli}）`)
  return cli
}

async function ensureMaaCli(signal) {
  const current = resolveMaaCliPath()
  if (await exists(current)) return current

  // An explicit but missing override is a configuration error. Do not hide it
  // by downloading another runtime that the override would continue to mask.
  const explicit = (process.env.DSH_MAA_CLI_PATH ?? process.env.MAA_CLI_PATH ?? '').trim()
  if (explicit !== '') throw new Error(`指定的 maa-cli 不存在：${explicit}`)

  if (runtimeBootstrapPromise === null) {
    runtimeBootstrapPromise = bootstrapRuntime({ run: runMaa, signal })
      .finally(() => { runtimeBootstrapPromise = null })
  }
  await runtimeBootstrapPromise
  return await requireMaaCli()
}

async function inspectMaaCompatibility(cliPath, signal) {
  const result = await runMaa(queryArguments('version'), { cliPath, signal, timeoutMs: 20_000 })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `maa-cli version exit ${result.exitCode}`)
  return parseMaaCompatibility(`${result.stdout}\n${result.stderr}`)
}

function memoryFallback(error, rejected = 0) {
  return { reused: 0, stored: 0, rejected, categories: [], error: error instanceof Error ? error.message : String(error) }
}

function memorySummary(memory) {
  if (memory.error) return `｜策略记忆未更新：${memory.error}`
  return `｜策略记忆：复用 ${memory.reused}，新增 ${memory.stored}${memory.rejected ? `，拒绝 ${memory.rejected}` : ''}`
}

async function strategyEnvironment(signal) {
  const cliPath = await requireMaaCli()
  const [directory, compatibility] = await Promise.all([
    runMaa(queryArguments('resource_dir'), { cliPath, signal, timeoutMs: 30_000 }),
    inspectMaaCompatibility(cliPath, signal),
  ])
  const resourceDir = directory.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
  if (directory.exitCode !== 0 || !resourceDir) throw new Error(`无法读取 MAA 资源目录：${directory.stderr || directory.stdout || `exit ${directory.exitCode}`}`)
  const [capabilities, itemIndex] = await Promise.all([
    discoverMaaCapabilities({ resourceDir, compatibility }),
    loadItemIndex(resourceDir).catch(() => null),
  ])
  return { resourceDir, compatibility, capabilities, itemIndex }
}

// Panel fields that need MAA resource data (item names for drop targets).
function panelContext(environment) { return { itemIndex: environment?.itemIndex ?? null } }

// Fight drop targets arrive from the model as item names or ids; MaaCore needs
// ids from item_index.json. Unknown names are rejected, never guessed.
function resolveStepDrops(steps, itemIndex) {
  return steps.map(step => {
    if (step?.type !== 'Fight' || step.drops === undefined) return step
    if (step.drops === null || typeof step.drops !== 'object' || Array.isArray(step.drops)) throw new Error('Fight.drops 必须是“物品名或 ID → 数量”的对象。')
    const drops = {}
    for (const [key, count] of Object.entries(step.drops)) {
      const id = resolveItemId(key, itemIndex)
      drops[id] = (drops[id] ?? 0) + count
    }
    return { ...step, drops }
  })
}

// Warn (do not block) when a weekly resource/chip stage is closed today
// according to the cached game data. Without a cache nothing is claimed.
async function weeklyStageWarnings(steps, resourceDir) {
  const codes = [...new Set(steps.filter(step => step?.type === 'Fight' && typeof step.stage === 'string').map(step => step.stage.trim()))]
  if (codes.length === 0) return []
  const data = await readPlanningData()
  if (!data?.weekly) return []
  const stages = await readMaaStages(resourceDir)
  const warnings = []
  for (const code of codes) {
    const zone = weeklyStageOpen(data, stages, code, { server: data.server })
    if (zone && zone.openToday === false) warnings.push(`${code}（${zone.name}）今天（${WEEKDAY_LABELS[zone.weekday]}）未开放，开放日：${zone.daysOfWeek.map(day => WEEKDAY_LABELS[day]).join('、')}`)
  }
  return warnings
}

const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

async function readMaaStages(resourceDir) {
  return await readFile(path.join(resourceDir, 'stages.json'), 'utf8').then(JSON.parse).catch(() => [])
}

function documentWithNoteStrategy(document, strategy) {
  if (strategy.kind === 'Roguelike') return structuredClone(document)
  const result = structuredClone(document)
  let replaced = false
  result.tasks = result.tasks.map(task => {
    if (replaced || !['Fight', 'Copilot'].includes(task?.type)) return task
    replaced = true
    return { type: 'Copilot', params: { filename: GENERATED_COPILOT_MARKER, formation: strategy.formation } }
  })
  if (!replaced) throw new Error('当前计划没有可替换为 Copilot 的作战任务。')
  return result
}

function roguelikeThemeOf(document) {
  const task = (document?.tasks ?? []).find(item => item?.type === 'Roguelike')
  return typeof task?.params?.theme === 'string' ? task.params.theme : ''
}

async function rememberConfirmedPanel(document, environment) {
  const tasks = Array.isArray(document?.tasks) ? document.tasks : []
  if (tasks.length === 0) return
  const hasRoguelike = tasks.some(task => task?.type === 'Roguelike')
  const capabilities = hasRoguelike
    ? environment?.capabilities ?? (await strategyEnvironment()).capabilities
    : undefined
  await rememberPanelValues(taskPanelFromDocument(document, capabilities, panelContext(environment)))
}

async function prepareNotePreview(agent, confirmationCode, rawNote, overrides, signal) {
  const note = decodeConfirmationNote(rawNote)
  const pending = await peekPendingPlan(agent)
  if (pending.confirmationCode !== confirmationCode) throw new Error('MAA 确认码与待确认计划不一致。')
  const environment = await strategyEnvironment(signal)
  const patch = Object.keys(overrides ?? {}).length ? applyTaskPanelOverrides(pending.document, overrides, environment.capabilities, panelContext(environment)) : null
  const previewPending = patch ? { ...pending, document: patch.document } : pending
  const parsed = await parseStrategyNote(note, previewPending)
  if (parsed.needsModel) {
    return {
      status: 'needs_model', note, recognized: parsed.recognized, unresolved: parsed.unresolved,
      modelPrompt: noteModelPrompt(parsed),
    }
  }
  const compiled = compileStrategyRequest(parsed.input)
  const applied = await applyStrategyMemory(compiled, { ...environment, persist: false })
  const details = await previewStrategyDetails(applied.strategy, environment.resourceDir)
  // A note may switch the roguelike theme. Rebuild the task chain for the new
  // theme instead of cloning the old plan, and keep the plan title in step with
  // it: the dock must never say one theme while MAA runs another.
  const noteTheme = applied.strategy.kind === 'Roguelike' ? applied.strategy.step?.theme ?? '' : ''
  const themeShifted = noteTheme !== '' && noteTheme !== roguelikeThemeOf(previewPending.document)
  const document = themeShifted
    ? buildTaskDocument([applied.strategy.step], environment.capabilities)
    : documentWithNoteStrategy(previewPending.document, applied.strategy)
  if (themeShifted) details.supported.unshift(`按备注切换到主题 ${noteTheme}，任务链已按该主题重建`)
  if (applied.strategy.kind === 'Copilot') {
    details.changes.unshift({ kind: 'task', target: 'MAA task chain', detail: `Fight → Copilot (${applied.strategy.stageName})` })
  }
  const preview = {
    status: 'ready', note, recognized: parsed.recognized,
    supported: details.supported, unsupported: details.unsupported, changes: details.changes,
    memory: applied.memory, strategy: applied.strategy, document,
    overrides: overrides ?? {}, adjustments: patch?.applied ?? [],
  }
  await updatePendingPlan(agent, current => ({
    ...current,
    ...(themeShifted ? { purpose: summarizePlan([applied.strategy.step], environment.capabilities) } : {}),
    notePreview: preview,
  }))
  return preview
}

function publicNotePreview(preview) {
  if (!preview) return null
  const { strategy: _strategy, document: _document, ...publicValue } = preview
  return publicValue
}

const STEP_PROPERTIES = {
  type: { type: 'string', enum: ['StartUp', 'Fight', 'Infrast', 'Recruit', 'Mall', 'Award', 'Roguelike', 'ReclamationAlgorithm', 'Depot', 'OperBox', 'Custom', 'CloseDown'] },
  clientType: { type: 'string', enum: ['Official', 'Bilibili', 'Txwy', 'YoStarEN', 'YoStarJP', 'YoStarKR'], description: 'Optional game client for the whole plan. It may appear on any step; all provided values must match.' },
  stage: { type: 'string', description: 'Stage code such as 1-7, CE-6, H8-4; use "Annihilation" (or 剿灭) for the current annihilation stage.' }, times: { type: 'integer' }, medicine: { type: 'integer' }, expiringMedicine: { type: 'integer' }, stone: { type: 'integer' },
  drops: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Fight only: stop as soon as ANY listed item reaches its quantity. Keys are MAA item names (e.g. 固源岩组) or item ids; the server resolves them via item_index.json. When drops is given, times may be omitted (defaults to 100 as an upper bound).' },
  mode: { type: 'integer', description: 'Infrast: 0 default or 20000 rotation. Custom schedules (10000) are prepared with maa_prepare_infrast.' }, facilities: { type: 'array', items: { type: 'string', enum: ['Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Dorm'] } },
  drones: { type: 'string', enum: ['_NotUse', 'Money', 'SyntheticJade', 'CombatRecord', 'PureGold', 'OriginStone', 'Chip'] }, threshold: { type: 'number' }, replenish: { type: 'boolean' }, dormNotStationed: { type: 'boolean' }, dormTrust: { type: 'boolean' },
  refresh: { type: 'boolean' }, select: { type: 'array', items: { type: 'integer' } }, confirm: { type: 'array', items: { type: 'integer' } }, setTime: { type: 'boolean' }, expedite: { type: 'boolean' }, permitReserve: { type: 'integer' }, firstTags: { type: 'array', items: { type: 'string' } }, extraTagsMode: { type: 'integer' },
  shopping: { type: 'boolean' }, buyFirst: { type: 'array', items: { type: 'string' } }, blacklist: { type: 'array', items: { type: 'string' } }, forceShoppingIfCreditFull: { type: 'boolean' }, onlyBuyDiscount: { type: 'boolean' }, reserveMaxCredit: { type: 'boolean' }, visitFriends: { type: 'boolean' }, creditFight: { type: 'boolean' },
  dailyWeekly: { type: 'boolean' }, mail: { type: 'boolean' }, freePull: { type: 'boolean' }, orundum: { type: 'boolean' }, mining: { type: 'boolean' }, specialAccess: { type: 'boolean' }, signInEvent: { type: 'boolean' },
  theme: { type: 'string', description: 'Theme id discovered from the active MAA resources; validated by the server.' }, squad: { type: 'string' }, coreChar: { type: 'string' }, roles: { type: 'string' }, startsCount: { type: 'integer' }, difficulty: { type: 'integer' }, useSupport: { type: 'boolean' }, useNonFriendSupport: { type: 'boolean' }, stopAtFinalBoss: { type: 'boolean' },
  toolToCraft: { type: 'string' }, numCraftBatches: { type: 'integer' }, taskNames: { type: 'array', items: { type: 'string' } },
}

function renderResult(_args, value) {
  const lines = []
  if (typeof value.summary === 'string' && typeof value.action === 'string') {
    lines.push(value.summary)
    if (Array.isArray(value.steps) && value.steps.length > 0) {
      lines.push('', ...value.steps.map(step => `- ${step.id}：${step.detail}`))
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.confirmationPhrase) {
    lines.push(`计划：${value.planSummary}`, '', '尚未操作游戏。请点击“确认并执行 MAA”；如果按钮不可见，也可输入本地命令：', `/maa confirm ${value.confirmationCode}`, '', '确认不会再次调用模型；计划 30 分钟内有效。')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.planSummary) lines.push(`Plan: ${value.planSummary}`, `Plan file: ${value.planFile}`)
  lines.push(`Command: ${value.command}`, `Exit code: ${value.exitCode}`, value.stdout || '(no stdout)')
  if (value.stderr) lines.push(`[stderr]\n${value.stderr}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderNoteResult(_args, value) {
  if (value.status === 'needs_model') {
    return [{ type: 'text', text: [value.modelPrompt, '', `仍未解析：${(value.unresolved ?? []).join('、')}`].join('\n') }]
  }
  return renderResult(_args, value)
}

function renderAgentResult(_args, value) {
  const lines = [value.summary]
  if (value.confirmationPhrase) lines.push('', '尚未操作游戏。请在确认面板核对目标、预算和步骤后确认，或输入：', `/maa confirm ${value.confirmationCode}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

// The 备注 field arrives URL-encoded on the local command plane so spaces
// survive. It is compiled and previewed by DSH; raw note text is never copied
// into a MaaCore task document.
export function decodeConfirmationNote(raw) {
  let decoded
  try {
    decoded = decodeURIComponent(String(raw ?? ''))
  } catch {
    throw new Error('备注的 URL 编码不合法，请在面板里重新输入。')
  }
  const clean = decoded.replace(/[\r\n\t]+/gu, ' ').trim()
  if (clean === '') return ''
  if (clean.length > 120) throw new Error('备注最多 120 个字符。')
  return clean
}

function formatCommandResult(result) {
  const feedback = result.executionFeedback ?? classifyMaaExecution(result)
  const lines = [feedback.headline, `计划：${result.planSummary}`, `执行验证：${feedback.detail}`]
  if (result.operatorBox) lines.push('', formatOperatorBoxScanResult(result.operatorBox))
  if (result.operatorBoxError) lines.push('', `干员 Box 结果读取失败：${result.operatorBoxError}`)
  if (result.depot) lines.push('', formatDepotScanResult(result.depot))
  if (result.depotError) lines.push('', `仓库结果读取失败：${result.depotError}`)
  if (result.maintenanceWarning) lines.push('', result.maintenanceWarning)
  if (result.stdout) lines.push('', result.stdout)
  if (result.stderr) lines.push('', result.stderr)
  return lines.join('\n')
}

export function classifyMaaExecution(result, strategyApplied = false) {
  const log = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  const statuses = [...log.matchAll(/^\[([^\]]+)\]\s+(Succeeded|Completed|Failed|Stopped|Unstarted)\s*$/gimu)]
    .map(match => ({ task: match[1], status: match[2] }))
  if (result?.exitCode !== 0) return {
    status: 'failed', headline: `MAA 执行失败（退出码 ${result?.exitCode ?? '未知'}）。`,
    detail: strategyApplied ? '策略配置已生成并交给 MAA，但 MAA 进程返回失败；不能视为策略执行成功。' : 'MAA 进程返回失败。', statuses,
  }
  if (statuses.some(item => item.status === 'Failed')) return {
    status: 'failed', headline: 'MAA 报告任务失败。', detail: '进程退出码为 0，但任务摘要包含 Failed。', statuses,
  }
  if (statuses.length && statuses.every(item => ['Succeeded', 'Completed'].includes(item.status))) return {
    status: 'verified', headline: 'MAA 已完成任务。', detail: `MAA 摘要确认完成：${statuses.map(item => item.task).join('、')}`, statuses,
  }
  const state = statuses.length ? statuses.map(item => `${item.task}=${item.status}`).join('、') : '日志中没有可识别的完成状态'
  return {
    status: 'unverified', headline: 'MAA 进程已正常结束，但任务结果未完全验证。',
    detail: `${state}；${strategyApplied ? '仅能确认策略已生成、加载并调用 MAA，不能据此声称游戏内动作成功。' : '不能仅凭退出码 0 声称游戏内任务成功。'}`,
    statuses,
  }
}

const activeExecutions = new Map()
const activeRuns = new Map()
const activeWorkflows = new Map()
const stopRequests = new Map()
// `/maa confirm` calls that are still between "clicked" and "run started",
// keyed by DSH session. A stop/close during that window aborts the launch.
const launches = new Map()
let launchQueue = Promise.resolve()
const STOP_WAIT_MS = 30_000
let activeStrategyExecution = false
let restartRecoveryPromise = null

function agentKey(agent) {
  if (!agent || agent.id === undefined) throw new Error('当前命令没有可用的 DSH 会话。')
  return String(agent.id)
}

// Which DSH session may control a run record:
//   self    – this plugin process owns the child and the caller's session started it
//   other   – this plugin process owns it, but another DSH session started it
//   foreign – another live plugin host process owns it (second DSH instance)
//   orphan  – nobody owns it any more (DSH restarted while maa-cli kept running)
function runOwnership(run, key) {
  if (!run) return 'none'
  if (activeRuns.has(run.id)) return run.sessionId === key ? 'self' : 'other'
  const ownerPid = Number(run.ownerPid)
  if (Number.isInteger(ownerPid) && ownerPid !== process.pid && isProcessAlive(ownerPid)) return 'foreign'
  return 'orphan'
}

function ownershipRefusal(run, ownership) {
  const label = run.purpose || run.confirmationCode || run.id
  if (ownership === 'other') return `正在执行的 MAA 任务（${label}）属于另一个 DSH 会话；为避免误停，请在发起它的会话里停止。`
  if (ownership === 'foreign') return `正在执行的 MAA 任务（${label}）由另一个仍在运行的 DSH 进程持有，本会话不会终止它。`
  return ''
}

async function executeRuntimeInstruction(request, agent = null) {
  const running = await activeRun()
  if (!running) return { status: 'not_running', message: '当前没有正在执行的 MAA 任务。', run: null }
  if (request.action === 'stop_now') {
    if (!agent) return { status: 'not_owned', message: '立即停止需要明确的 DSH 会话。', run: running }
    const stopped = await stopExecution(agent, running.id)
    return { ...stopped, message: stopped.message ?? formatStopOutcome(stopped).text }
  }
  // Read-only progress is shared; anything that changes the run stays with
  // the session that owns it.
  if (agent && request.action !== 'status') {
    const ownership = runOwnership(running, agentKey(agent))
    if (ownership === 'other' || ownership === 'foreign') return { status: 'not_owned', message: ownershipRefusal(running, ownership), run: running }
  }
  const active = activeRuns.get(running.id)
  const result = await applyRuntimeInstruction(running.id, request, {
    monitorAvailable: Boolean(active?.monitor),
    stop: instructionId => {
      if (!active) return
      active.triggerInstructionId = instructionId
      active.controller.abort()
    },
  })
  const latest = await getRun(running.id)
  return { ...result, run: latest }
}

function settleWithin(promise, ms) {
  let timer
  return Promise.race([
    Promise.resolve(promise).then(value => ({ settled: true, value }), error => ({ settled: true, error })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), ms) }),
  ]).finally(() => clearTimeout(timer))
}

function stopWaitMs() {
  const configured = Number(process.env.DSH_MAA_STOP_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : STOP_WAIT_MS
}

// Stop exactly one run (or a confirmation that is still launching) on behalf
// of one DSH session. `target` may be a RUN-…, a MAA-… confirmation code or a
// workflow id; without a target the caller's own current task is stopped.
// Resolves only after the process tree has exited and the record, temporary
// resources and instructions have been settled — or reports why it could not.
async function stopExecution(agent, target = '') {
  const key = agentKey(agent)
  const wanted = String(target ?? '').trim().toUpperCase()
  const matches = (...ids) => wanted === '' || ids.some(id => id && String(id).toUpperCase() === wanted)

  // 1. A `/maa confirm` of this session that has not produced a run yet.
  const launch = launches.get(key)
  let launchCode = ''
  if (launch && matches(launch.code, launch.runId)) {
    launchCode = launch.code
    launch.controller.abort()
    const waited = await settleWithin(launch.settled, stopWaitMs())
    if (!waited.settled) {
      return { status: 'stop_failed', run: null, code: launch.code, message: `停止请求已发出，但确认流程在 ${Math.round(stopWaitMs() / 1000)} 秒内没有结束；请稍后重试停止。` }
    }
  }

  // 2. Goal workflows started from this session.
  const workflows = [...activeWorkflows.values()].filter(item => item.sessionKey === key && matches(item.executionId, item.confirmationCode, item.runId))
  for (const workflow of workflows) workflow.controller.abort()

  // 3. The run record itself.
  const state = await readRunState()
  const lookup = wanted || launchCode
  let run = lookup
    ? state.runs.find(item => item.id.toUpperCase() === lookup || (item.confirmationCode && item.confirmationCode.toUpperCase() === lookup)) ?? null
    : null
  if (!run && workflows.length) run = state.runs.find(item => item.status === 'running' && item.sessionId === key) ?? null
  if (!run && !lookup) {
    // The caller's own task first; then whatever is live (ownership decides
    // whether this session may touch it); finally an interrupted leftover.
    run = state.runs.find(item => item.status === 'running' && item.sessionId === key)
      ?? await activeRun()
      ?? state.runs.find(item => item.status === 'running')
      ?? null
  }
  if (!run) {
    if (workflows.length) {
      await settleWithin(Promise.all(workflows.map(item => item.done)), stopWaitMs())
      return { status: 'stopped', run: null, message: '目标工作流已停止。' }
    }
    if (launchCode) return { status: 'cancelled_launch', run: null, code: launchCode, message: `已在开始执行前取消（${launchCode}）；没有启动 MAA，确认码已失效。` }
    return { status: 'not_running', run: null }
  }
  if (run.status !== 'running') return { status: 'already_finished', run: summarizeForStop(run) }
  const ownership = runOwnership(run, key)
  if (ownership === 'other' || ownership === 'foreign') return { status: 'not_owned', run: summarizeForStop(run), message: ownershipRefusal(run, ownership) }

  const existing = stopRequests.get(run.id)
  if (existing) return await existing
  const request = (async () => {
    if (ownership === 'orphan') {
      try {
        const stopped = await stopRun(run.id, { summary: '已停止（终止了 DSH 不再持有的残留进程树）。' })
        await completeTriggeredInstructions(run.id).catch(() => {})
        return { status: 'stopped', run: summarizeForStop(stopped) }
      } catch (error) {
        return { status: 'stop_failed', run: summarizeForStop(await getRun(run.id)), message: error instanceof Error ? error.message : String(error) }
      }
    }
    const active = activeRuns.get(run.id)
    if (!active) {
      // It settled between the lookup and now.
      const settled = await getRun(run.id)
      return settled?.status === 'running'
        ? { status: 'stop_failed', run: summarizeForStop(settled), message: '任务状态正在切换，请重试停止。' }
        : { status: 'already_finished', run: summarizeForStop(settled) }
    }
    await markRunStopping(run.id)
    await applyRuntimeInstruction(run.id, { action: 'stop_now' }, {
      monitorAvailable: Boolean(active?.monitor),
      stop: instructionId => { active.triggerInstructionId = instructionId },
    }).catch(() => {})
    active.controller.abort()
    // Re-issue the tree kill on every attempt: a previous attempt may have
    // failed (access denied, taskkill missing) and the user is retrying.
    const kill = typeof active.kill === 'function' ? await active.kill().catch(error => ({ ok: false, detail: error.message })) : { ok: true }
    const waited = await settleWithin(active.completion, stopWaitMs())
    if (!waited.settled) {
      const reason = `MAA 进程在 ${Math.round(stopWaitMs() / 1000)} 秒内没有退出${kill && kill.ok === false ? `（${kill.detail}）` : ''}。`
      await clearRunStopping(run.id, reason).catch(() => {})
      return { status: 'stop_failed', run: summarizeForStop(await getRun(run.id)), message: `停止失败：${reason}任务仍在执行，停止按钮保持可用，可以重试。` }
    }
    await settleWithin(Promise.all(workflows.map(item => item.done)), stopWaitMs())
    return { status: 'stopped', run: summarizeForStop(await getRun(run.id)) }
  })()
  stopRequests.set(run.id, request)
  try { return await request } finally { if (stopRequests.get(run.id) === request) stopRequests.delete(run.id) }
}

// What the composer dock of ONE session needs after a refresh, a DSH restart
// or a conversation switch: the live run with its ownership, a confirmation
// that is still launching, and the session's own pending plan (code only).
async function sessionRunStatus(agent) {
  const key = agentKey(agent)
  const snapshot = await describeRunState()
  const raw = await readRunState()
  const annotate = item => {
    if (!item) return null
    const record = raw.runs.find(run => run.id === item.id)
    return { ...item, owner: runOwnership(record, key) }
  }
  const launch = launches.get(key)
  let pending = null
  try {
    const plan = await peekPendingPlan(agent)
    if (Date.now() - Number(plan.preparedAt) <= 30 * 60_000) pending = { code: plan.confirmationCode, summary: plan.planSummary ?? '' }
  } catch {}
  return {
    ...snapshot,
    running: annotate(snapshot.running),
    interrupted: annotate(snapshot.interrupted),
    launching: launch ? { code: launch.code, runId: launch.runId || '' } : null,
    pending,
  }
}

async function cancelPendingWorkflow(executionId, goalId = '') {
  await updateWorkflowExecution(executionId, value => {
    if (value.status === 'pending_confirmation') {
      value.status = 'cancelled'
      value.needsUser = ''
    }
    return value
  })
  if (goalId) {
    const goal = await getGoal(goalId)
    if (goal?.status === 'pending_confirmation' && goal.workflowExecutionId === executionId) await updateGoal(goalId, { status: 'cancelled', needsUser: '' })
  }
}

function summarizeForStop(run) {
  if (!run) return null
  return { id: run.id, status: run.status, purpose: run.purpose, confirmationCode: run.confirmationCode, summary: run.summary, exitCode: run.exitCode, stopError: run.stopError ?? '' }
}

function formatStopOutcome(outcome) {
  const run = outcome.run
  if (outcome.status === 'stopped' && run) {
    return { kind: 'success', text: `MAA 任务已${run.status === 'stopped' ? '停止' : '结束'}（${run.id}）；进程已退出，运行记录与临时资源已完成结算。` }
  }
  if (outcome.status === 'stopped') return { kind: 'success', text: outcome.message || '任务已停止。' }
  if (outcome.status === 'cancelled_launch') return { kind: 'success', text: outcome.message }
  if (outcome.status === 'already_finished' && run) {
    const label = { succeeded: '已完成', failed: '已失败', stopped: '已停止' }[run.status] ?? '已结束'
    return { kind: 'success', text: `MAA 任务${label}（${run.id}），无需再次停止。` }
  }
  if (outcome.status === 'not_running') return { kind: 'error', text: '当前没有正在执行的 MAA 任务。' }
  return { kind: 'error', text: outcome.message || '已发送停止请求，但尚未确认 MAA 进程退出，请查看运行状态。' }
}

function formatRuntimeInstructionResult(result) {
  if (result.status === 'ok' && result.run) return JSON.stringify({ running: result.run })
  return result.message || JSON.stringify(result)
}

async function runWithRecovery({ runArguments, runOptions, document, run, active, executionSignal }) {
  let attempt = 0
  while (true) {
    active.failureCallbacks = []
    await updateRunRecovery(run.id, { status: attempt > 0 ? 'retrying' : 'monitoring', attempt, maxRetries: MAX_RECOVERY_RETRIES, needsUser: false, nextRetryAt: null })
    let result = null
    let failureError = null
    try {
      const handle = startMaa(runArguments, { ...runOptions, hardTimeoutMs: 6 * 60 * 60_000 })
      active.pid = handle.pid
      active.kill = handle.kill
      // Persist the exact process tree so a stop after a DSH restart targets
      // it, and never another DSH instance's or the user's own MAA.
      await setRunProcess(run.id, handle.pid).catch(() => {})
      result = await handle.done
      if (!isExecutionFailure(result)) {
        if (attempt > 0) await updateRunRecovery(run.id, { status: 'recovered', needsUser: false, historyEntry: { at: Date.now(), action: 'recovered', detail: `第 ${attempt} 次重试后任务恢复。` } })
        else await updateRunRecovery(run.id, { status: 'not_needed' })
        return result
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      failureError = error
    }

    const diagnosis = diagnoseExecutionFailure({ result, error: failureError, callbacks: active.failureCallbacks })
    const latest = await getRun(run.id)
    let emulator = null
    if (diagnosis.suggestedAction === 'probe_adb') emulator = await checkEmulator({ runMaa, signal: executionSignal }).catch(() => null)
    const decision = decideRecovery({ diagnosis, document, attempt, checkpoints: latest?.checkpoints ?? [], emulator })
    await updateRunRecovery(run.id, {
      status: decision.action === 'retry' ? 'waiting_retry' : 'needs_user',
      attempt,
      diagnosis,
      needsUser: decision.action !== 'retry',
      nextRetryAt: decision.action === 'retry' ? Date.now() + decision.delayMs : null,
      historyEntry: { at: Date.now(), action: decision.action, detail: `${diagnosis.reason} ${decision.reason}` },
    })
    if (decision.action !== 'retry') {
      if (result) return result
      throw failureError ?? new Error(diagnosis.reason)
    }
    await abortableDelay(decision.delayMs, executionSignal)
    attempt += 1
  }
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('recovery cancelled'), { name: 'AbortError' }))
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(Object.assign(new Error('recovery cancelled'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

// A running MAA task owns the emulator, the generated task file, and the user
// resource overlay. Until it ends no new plan may replace them, not even from
// another DSH session.
async function assertNoActiveRun() {
  if (activeWorkflows.size > 0) throw new Error('当前有目标工作流正在执行或等待步骤反馈，请先停止或处理该工作流。')
  const running = await activeRun()
  if (!running) return
  throw new Error(`MAA 任务正在执行中（${running.purpose || running.confirmationCode || running.id}，已运行 ${new Date(running.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} 起）。为避免抢屏幕和覆盖临时资源，完成前不接受新的计划或任务；可以等待，或在确认面板点击「停止任务」/ 输入 /maa stop。`)
}

async function executeDocument(agent, signal, document, planSummary, options = {}) {
  const key = agentKey(agent)
  if (activeExecutions.has(key)) throw new Error('当前 DSH 会话已有一个 MAA 任务正在执行。')
  // A stop/close that arrived while the confirmation was still launching wins:
  // no run record, no process.
  if (options.abortSignal?.aborted) throw Object.assign(new Error('已在开始执行前取消。'), { name: 'AbortError' })
  // Persist the lifecycle before doing any work: the composer control panel and
  // a DSH restart both read this record, not a component's local state.
  const run = await beginRun({
    purpose: options.purpose ?? '',
    planSummary,
    confirmationCode: options.confirmationCode ?? '',
    sessionId: key,
    taskTypes: document.tasks?.map(task => task.type) ?? [],
  })
  const controller = new AbortController()
  // Background runs must not inherit the command's signal: the command plane may
  // abort it the moment the handler returns, which would kill a healthy MAA run.
  const backgroundWanted = options.background === true
  const executionSignal = backgroundWanted
    ? controller.signal
    : (signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
  let resolveCompletion
  const completion = new Promise(resolve => { resolveCompletion = resolve })
  const active = { controller, planSummary, runId: run.id, sessionKey: key, monitor: null, triggerInstructionId: '', failureCallbacks: [], pid: null, kill: null, completion }
  activeExecutions.set(key, active)
  activeRuns.set(run.id, active)
  if (typeof options.onRunStarted === 'function') {
    try { options.onRunStarted(run) } catch {}
  }
  const linkedAbort = () => controller.abort()
  if (options.abortSignal) {
    if (options.abortSignal.aborted) controller.abort()
    else options.abortSignal.addEventListener('abort', linkedAbort, { once: true })
  }
  let strategyExecution = null
  let generatedExecution = null
  let strategyReserved = false
  let recorded = { status: 'failed', exitCode: null, summary: 'MAA 执行没有返回结果。' }
  let detached = false

  const release = async () => {
    // Never let bookkeeping failure hide the execution outcome.
    if (active.monitor) {
      await active.monitor.flush().catch(() => {})
      active.monitor.stop()
    }
    const notices = recruitNotices(await getRun(run.id).catch(() => null))
    if (notices.length) recorded = { ...recorded, summary: `${recorded.summary}｜公招提醒：${notices.join('；')}（未自动确认，请在游戏内处理）` }
    await finishRun(run.id, recorded).catch(() => {})
    await completeTriggeredInstructions(run.id).catch(() => {})
    try {
      if (generatedExecution) await generatedExecution.restore().catch(() => {})
      if (strategyExecution) await strategyExecution.restore()
    } finally {
      options.abortSignal?.removeEventListener('abort', linkedAbort)
      if (strategyReserved) activeStrategyExecution = false
      if (activeExecutions.get(key) === active) activeExecutions.delete(key)
      if (activeRuns.get(run.id) === active) activeRuns.delete(run.id)
      resolveCompletion(await getRun(run.id).catch(() => null))
    }
  }

  try {
    const cliPath = await ensureMaaCli(executionSignal)
    const maintenance = isRuntimePath(cliPath)
      ? await maybeAutoUpdateRuntime({ run: runMaa, signal: executionSignal, allowed: activeExecutions.size === 1 })
      : { warning: '' }
    if (options.emulatorChecked !== true) {
      const emulator = await checkEmulator({ runMaa, signal: executionSignal })
      if (!emulator.ok) throw new Error(emulatorErrorMessage(emulator))
    }
    await prepareRuntimeDirectories({ runMaa, signal: executionSignal }).catch(() => [])
    // Ask the exact maa-cli process where it reads configuration. This matters
    // when the plugin-private runtime redirects MAA_CONFIG_DIR.
    const configResult = await runMaa(queryArguments('config_dir'), { signal: executionSignal, timeoutMs: 20_000 })
    const configDir = configResult.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
    if (configResult.exitCode !== 0 || !configDir) {
      throw new Error(`无法确定 maa-cli 配置目录：${configResult.stderr || configResult.stdout || `exit ${configResult.exitCode}`}`)
    }
    let executionDocument = document
    if (options.strategy) {
      if (activeStrategyExecution) throw new Error('另一条 MAA 策略正在覆盖共享资源，请等它结束后再确认。')
      activeStrategyExecution = true
      strategyReserved = true
      const resourceResult = await runMaa(queryArguments('resource_dir'), { signal: executionSignal, timeoutMs: 20_000 })
      const resourceDir = resourceResult.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
      if (resourceResult.exitCode !== 0 || !resourceDir) {
        throw new Error(`无法确定 MAA 资源目录：${resourceResult.stderr || resourceResult.stdout || `exit ${resourceResult.exitCode}`}`)
      }
      strategyExecution = await materializeStrategy(document, options.strategy, { resourceDir, configDir })
      executionDocument = strategyExecution.document
      const runtimeFallbacks = strategyExecution.unsupported.filter(item => !planSummary.includes(item.request))
      if (runtimeFallbacks.length) planSummary = `${planSummary}｜执行时安全回退：${runtimeFallbacks.map(item => item.request).join('、')}`
    }
    if (Array.isArray(options.generatedFiles) && options.generatedFiles.length > 0) {
      generatedExecution = await materializeGeneratedFiles(executionDocument, options.generatedFiles, { configDir })
      executionDocument = generatedExecution.document
    }
    assertNoGeneratedMarkers(executionDocument)
    const written = await writeGeneratedTask(executionDocument, { configDir })
    const hasOperatorBox = executionDocument.tasks.some(task => task.type === 'OperBox')
    const hasDepot = executionDocument.tasks.some(task => task.type === 'Depot')
    const settle = async result => {
      const executionFeedback = classifyMaaExecution(result, strategyExecution !== null)
      recorded = {
        status: executionFeedback.status === 'failed' || result.exitCode !== 0 ? 'failed' : 'succeeded',
        exitCode: result.exitCode,
        summary: executionFeedback.headline,
      }
      const enriched = {
        ...result,
        runId: run.id,
        stderr: stripDepotCallbacks(stripOperBoxCallbacks(result.stderr)),
        planFile: written.path, planJson: written.json, planSummary, maintenanceWarning: maintenance.warning, executionFeedback,
      }
      if (result.exitCode !== 0) return enriched
      const completeLog = `${result.stdout}\n${result.stderr}`
      if (hasOperatorBox) {
        try {
          enriched.operatorBox = parseCompletedOperatorBox(completeLog)
          await saveOperatorBox(enriched.operatorBox)
        } catch (error) {
          enriched.operatorBoxError = error instanceof Error ? error.message : String(error)
        }
      }
      if (hasDepot) {
        try {
          enriched.depot = parseCompletedDepot(completeLog)
          await saveDepot(enriched.depot)
        } catch (error) {
          enriched.depotError = error instanceof Error ? error.message : String(error)
        }
      }
      if (enriched.operatorBoxError || enriched.depotError) {
        recorded = { status: 'failed', exitCode: result.exitCode, summary: '任务已执行，但结构化状态缓存不完整。' }
      }
      return enriched
    }
    const runOptions = {
      signal: executionSignal,
      timeoutMs: 30 * 60_000,
      outputLimit: hasOperatorBox || hasDepot ? 16 * 1024 * 1024 : undefined,
      envPatch: hasOperatorBox || hasDepot ? { MAA_LOG: 'info', MAA_LOG_PREFIX: 'Never' } : undefined,
    }
    const runArguments = actionArguments('run_task', GENERATED_TASK_NAME, true, strategyExecution?.userResource === true)
    const logResult = await runMaa(queryArguments('log_dir'), { signal: executionSignal, timeoutMs: 20_000 })
    const logDir = logResult.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
    if (logResult.exitCode === 0 && logDir) {
      const seen = new Set()
      active.monitor = await startLogTail(path.join(logDir, 'asst.log'), async line => {
        const callback = parseMaaCallbackLine(line)
        if (!callback) return
        const signature = line
        if (seen.has(signature)) return
        seen.add(signature)
        if (seen.size > 200) seen.delete(seen.values().next().value)
        active.failureCallbacks.push(callback)
        if (active.failureCallbacks.length > 100) active.failureCallbacks.shift()
        const checkpoint = callbackCheckpoint(callback)
        if (checkpoint) await addRunCheckpoint(run.id, checkpoint)
        await processMaaCallback(run.id, callback, {
          stop: instructionId => {
            active.triggerInstructionId = instructionId
            controller.abort()
          },
        })
      })
    }
    const execution = runWithRecovery({ runArguments, runOptions, document: executionDocument, run, active, executionSignal })
    if (!backgroundWanted) return await settle(await execution)
    // Background mode: return as soon as the first MAA attempt is running. The
    // recovery loop and process tree remain owned by this plugin process.
    detached = true
    void execution
      .then(result => settle(result))
      .catch(error => {
        recorded = error?.name === 'AbortError'
          ? { status: 'stopped', exitCode: null, summary: '已停止。' }
          : { status: 'failed', exitCode: null, summary: error instanceof Error ? error.message : String(error) }
      })
      .finally(() => { void release() })
    return {
      background: true,
      runId: run.id,
      pid: active.pid,
      planFile: written.path,
      planJson: written.json,
      planSummary,
      maintenanceWarning: maintenance.warning,
      executionFeedback: {
        status: 'running',
        headline: 'MAA 已开始执行。',
        detail: '任务在后台运行：面板显示「执行中」与本地计时，需要中止时点击「停止任务」或输入 /maa stop；结束后点「查看执行记录」查看结果。',
        statuses: [],
      },
    }
  } catch (error) {
    recorded = error?.name === 'AbortError'
      ? { status: 'stopped', exitCode: null, summary: '已停止。' }
      : { status: 'failed', exitCode: null, summary: error instanceof Error ? error.message : String(error) }
    throw error
  } finally {
    // A detached child settles the record itself when it exits.
    if (!detached) await release()
  }
}

async function goalPlanningContext(signal, server = 'CN', includePlanningData = true) {
  const environment = await strategyEnvironment(signal)
  const [operatorBox, depot, itemIndex, stages, planningResult] = await Promise.all([
    readOperatorBox(),
    readDepot(),
    environment.itemIndex ?? loadItemIndex(environment.resourceDir),
    readMaaStages(environment.resourceDir),
    includePlanningData
      ? loadPlanningData({ server, signal }).then(value => ({ value, error: '' }), error => ({ value: null, error: error instanceof Error ? error.message : String(error) }))
      : Promise.resolve({ value: null, error: '' }),
  ])
  const jointPlanner = requirements => planWithArkPlanner({ requirements, depot, itemIndex, server }, { signal })
  return { ...environment, operatorBox, depot, itemIndex, stages, planningData: planningResult.value, planningDataError: planningResult.error, jointPlanner }
}

const TRAINING_TARGET_PROPERTIES = {
  operator: { type: 'string' },
  targetElite: { type: 'integer', minimum: 0, maximum: 2, description: 'Target elite phase. Omit together with targetLevel when only skills/modules are wanted.' },
  targetLevel: { type: 'integer', minimum: 1, maximum: 90 },
  skillLevel: { type: 'object', additionalProperties: false, properties: { current: { type: 'integer', minimum: 1, maximum: 7 }, target: { type: 'integer', minimum: 1, maximum: 7 } }, description: 'Common skill level 1-7. current must come from the user: the Box scan has no skill levels.' },
  masteries: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['skill', 'target'], properties: { skill: { type: 'integer', minimum: 1, maximum: 3 }, current: { type: 'integer', minimum: 0, maximum: 3 }, target: { type: 'integer', minimum: 1, maximum: 3 } } }, description: 'Specialization goals, e.g. skill 2 to M3. current (0 = none) must come from the user.' },
  modules: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['target'], properties: { type: { type: 'string', description: 'Module type letter such as X / Y / D, or its name.' }, current: { type: 'integer', minimum: 0, maximum: 3 }, target: { type: 'integer', minimum: 1, maximum: 3 } } }, description: 'Module goals. current (0 = locked) must come from the user.' },
}

// Read-only "do I have enough for …" answer built from the same calculation
// the goal planner uses.
async function estimateTraining(args, signal) {
  const context = await goalPlanningContext(signal, args.server, true)
  if (!context.operatorBox) return agentResult({ status: 'needs_input', summary: '还没有干员 Box 缓存，无法得知干员当前练度。可以先确认一次 Box 扫描（/maa box）。' })
  if (!context.planningData) return agentResult({ status: 'needs_input', summary: `无法取得培养数据：${context.planningDataError || '未知原因'}` })
  const calculated = trainingRequirements(args, context)
  if (calculated.needsUser) return agentResult({ status: 'needs_input', summary: [...calculated.facts, calculated.needsUser].join('\n') })
  const nameOf = id => context.itemIndex?.byId?.get(id)?.name ?? id
  const lines = [...calculated.facts]
  if (!context.depot) {
    lines.push('没有仓库缓存，以下为总需求（未扣除库存）：', ...calculated.requirements.map(item => `- ${nameOf(item.itemId)} ×${item.quantity}`))
    return agentResult({ status: 'partial', summary: lines.join('\n'), data: calculated })
  }
  const joint = await context.jointPlanner(calculated.baseRequirements).catch(() => null)
  const jointUsable = joint?.source === 'arkplanner' && joint.stages.length > 0
  if (!jointUsable && calculated.synthesisFact) lines.push(calculated.synthesisFact)
  const rows = jointUsable
    ? applyJointPlan(calculated.baseRequirements, joint, context.depot)
    : applyDropRates(calculated.requirements, context.planningData, context.depot, context.stages)
  const short = rows.filter(row => row.gap > 0)
  lines.push(short.length === 0 ? '按当前仓库缓存，材料已经足够。' : `仍缺 ${short.length} 种材料：`)
  for (const row of short) lines.push(`- ${nameOf(row.itemId)}：需要 ${row.quantity}，库存 ${row.quantity - row.gap}，缺 ${row.gap}${row.stage ? `；建议 ${row.stage}×${row.runs}${row.drop?.source === 'arkplanner' ? '（ArkPlanner）' : ''}` : ''}`)
  if (joint && joint.source !== 'arkplanner') lines.push(`ArkPlanner 暂不可用（${joint.error}），关卡建议按单材料期望理智计算，未联合优化。`)
  lines.push(`仓库缓存时间：${context.depot.scannedAt}；掉率为统计期望，不是保证。`)
  return agentResult({ status: 'ready', summary: lines.join('\n'), data: { requirements: calculated.requirements, gaps: short, syntheses: calculated.syntheses, joint: joint?.source ?? 'none' } })
}

function agentResult(input = {}) {
  return {
    status: String(input.status ?? 'ok'), summary: String(input.summary ?? ''),
    goalId: String(input.goalId ?? ''), workflowId: String(input.workflowId ?? ''),
    confirmationCode: String(input.confirmationCode ?? ''), confirmationPhrase: String(input.confirmationPhrase ?? ''),
    expiresAt: String(input.expiresAt ?? ''), data: typeof input.data === 'string' ? input.data : JSON.stringify(input.data ?? null),
  }
}

async function prepareGoalConfirmation(args, exec) {
  await assertNoActiveRun()
  const context = await goalPlanningContext(exec.signal, args.server, ['operator_training', 'materials'].includes(args.kind))
  const input = structuredClone(args)
  if (input.kind === 'custom') {
    const document = buildTaskDocument(input.steps, context.capabilities)
    input.steps = document.tasks.map((task, index) => ({ id: `custom-${index + 1}`, kind: 'maa', title: `${index + 1}. ${task.type}`, maa: task }))
  }
  const plan = await planGoal(input, context)
  const goal = await createGoal({ ...input, title: input.title || input.purpose || goalTitle(input) }, plan)
  if (plan.status !== 'ready') return agentResult({ status: 'needs_input', goalId: goal.id, summary: `${goal.title}：${plan.needsUser}`, data: goal })
  const execution = await createWorkflowExecution({
    goalId: goal.id, name: goal.title, steps: plan.steps, constraints: plan.constraints,
    capabilitySignature: context.capabilities.signature,
  })
  await updateGoal(goal.id, { workflowExecutionId: execution.id })
  const summary = `${goal.title}｜${execution.steps.length} 步｜预算：源石${plan.constraints.allowStone ? '仅按明确数量' : '禁止'}、普通理智药 ${plan.constraints.maxMedicine}、过期理智药 ${plan.constraints.maxExpiringMedicine}${plan.constraints.maxSanity === null ? '' : `、理智上限 ${plan.constraints.maxSanity}`}`
  const confirmation = await preparePendingPlan(exec.agent, {
    purpose: goal.title, document: workflowDocument(execution), planSummary: summary,
    workflowExecutionId: execution.id, goalId: goal.id,
    goalPreview: { ...goal, workflowExecutionId: execution.id, steps: execution.steps },
  })
  exec.concludeTurn()
  return agentResult({ status: 'pending_confirmation', goalId: goal.id, workflowId: execution.id, summary, ...confirmation, data: { goal, execution } })
}

function goalTitle(input) {
  if (input.kind === 'daily') return '完成今天的日常任务'
  if (input.kind === 'operator_training') return `培养${Array.isArray(input.operators) && input.operators.length ? input.operators.map(item => item.operator).join('、') : input.operator || '指定干员'}`
  if (input.kind === 'materials') return '规划并获取缺少的材料'
  return '自定义游戏目标'
}

function workflowSummary(execution) {
  const completed = execution.steps.filter(step => step.status === 'completed').length
  return `${execution.name}：${completed}/${execution.steps.length} 步，状态 ${execution.status}${execution.needsUser ? `；${execution.needsUser}` : ''}`
}

async function startWorkflowExecution(agent, executionId, goalId = '', confirmationCode = '') {
  if (activeWorkflows.has(executionId)) throw new Error('该工作流已经在执行。')
  const execution = await getWorkflowExecution(executionId)
  if (!execution) throw new Error('找不到待执行工作流。')
  if (execution.status !== 'pending_confirmation') throw new Error(`工作流状态为 ${execution.status}，不能重复启动。`)
  const effectiveGoalId = goalId || execution.goalId
  if (effectiveGoalId) {
    const goal = await getGoal(effectiveGoalId)
    if (!goal || goal.workflowExecutionId !== executionId || goal.status !== 'pending_confirmation') {
      throw new Error('该目标已被重新规划、取消或执行过；为避免重复操作，旧工作流不能启动。')
    }
  }
  const controller = new AbortController()
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const active = { controller, executionId, goalId: effectiveGoalId, sessionKey: agentKey(agent), confirmationCode, done }
  activeWorkflows.set(executionId, active)
  await updateWorkflowExecution(executionId, current => { current.status = 'running'; current.needsUser = ''; return current })
  if (active.goalId) await updateGoal(active.goalId, { status: 'running' })

  void (async () => {
    try {
      while (!controller.signal.aborted) {
        const current = await getWorkflowExecution(executionId)
        const step = current?.steps[current.cursor]
        if (!current || !step) {
          await updateWorkflowExecution(executionId, value => { value.status = 'completed'; return value })
          if (active.goalId) await updateGoal(active.goalId, {
            status: 'awaiting_goal_verification',
            needsUser: '工作流步骤已完成，但这不等同于游戏目标已达成；请根据最新 Box、Depot 或游戏状态确认目标。',
          })
          return
        }
        if (step.kind === 'decision') {
          await updateWorkflowExecution(executionId, value => {
            value.status = 'needs_user'; value.needsUser = step.prompt
            value.steps[value.cursor].status = 'waiting'
            return value
          })
          if (active.goalId) await updateGoal(active.goalId, { status: 'needs_user', needsUser: step.prompt })
          return
        }
        await updateWorkflowExecution(executionId, value => {
          const target = value.steps[value.cursor]
          target.status = 'running'; target.attempts += 1; target.startedAt = Date.now()
          return value
        })
        const result = await executeDocument(agent, controller.signal, { tasks: [step.maa] }, `${current.name}｜${step.title}`, {
          background: false, purpose: `工作流：${current.name}`, confirmationCode,
        })
        const verified = result.executionFeedback?.status === 'verified' && !result.operatorBoxError && !result.depotError
        if (!verified) {
          const feedback = result.operatorBoxError || result.depotError || result.executionFeedback?.detail || 'MAA 未提供可验证的完成状态。'
          await updateWorkflowExecution(executionId, value => {
            const target = value.steps[value.cursor]
            target.status = result.executionFeedback?.status === 'failed' ? 'failed' : 'uncertain'
            target.runId = result.runId ?? ''; target.feedback = feedback; target.finishedAt = Date.now()
            value.status = 'needs_review'; value.needsUser = `步骤“${target.title}”没有可靠完成证据：${feedback}`
            return value
          })
          if (active.goalId) await updateGoal(active.goalId, { status: 'needs_user', needsUser: `工作流步骤未验证：${feedback}` })
          return
        }
        await updateWorkflowExecution(executionId, value => {
          const target = value.steps[value.cursor]
          target.status = 'completed'; target.runId = result.runId ?? ''; target.feedback = result.executionFeedback.detail; target.finishedAt = Date.now()
          value.cursor += 1
          return value
        })
      }
      throw Object.assign(new Error('workflow cancelled'), { name: 'AbortError' })
    } catch (error) {
      const stopped = error?.name === 'AbortError'
      await updateWorkflowExecution(executionId, value => {
        value.status = stopped ? 'stopped' : 'needs_review'
        value.needsUser = stopped ? '用户已停止工作流。' : `工作流异常中断：${error instanceof Error ? error.message : String(error)}`
        const step = value.steps[value.cursor]
        if (step?.status === 'running') { step.status = stopped ? 'stopped' : 'uncertain'; step.finishedAt = Date.now() }
        return value
      }).catch(() => {})
      if (active.goalId) await updateGoal(active.goalId, { status: stopped ? 'stopped' : 'needs_user', needsUser: stopped ? '' : '工作流异常中断，需要检查。' }).catch(() => {})
    } finally {
      activeWorkflows.delete(executionId)
      resolveDone()
    }
  })()
  return await getWorkflowExecution(executionId)
}

async function recoverAfterRestart() {
  const interrupted = await auditInterruptedWorkflows()
  const state = await readRunState()
  let reaped = { killed: 0 }
  // Every record still marked running was started by an earlier plugin process
  // (this one has not started anything yet). Leave records that a different,
  // still-alive DSH process owns; terminate only the recorded process tree of
  // genuine orphans and settle their record.
  for (const orphan of state.runs.filter(run => run.status === 'running' && !activeRuns.has(run.id))) {
    if (runOwnership(orphan, '') === 'foreign') continue
    const stopped = await stopRun(orphan.id, { summary: 'DSH 重启后已终止残留任务并结算记录。' }).catch(() => null)
    if (stopped) reaped = { killed: reaped.killed + 1 }
  }
  let overlay = null
  try {
    const result = await runMaa(queryArguments('config_dir'), { timeoutMs: 20_000 })
    const configDir = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1)
    if (result.exitCode === 0 && configDir) overlay = await recoverStrategyOverlay(configDir)
  } catch {}
  return { interrupted, reaped: reaped.killed, overlay }
}

// The human-gesture confirmation. `launch.controller` is aborted by a stop or
// close that arrives before the run exists; every await below re-checks it so
// an aborted confirmation never consumes the code or starts MAA afterwards.
async function confirmPlan(agent, parsed, signal, launch) {
  const launchSignal = launch.controller.signal
  let consumed = false
  try {
    return await confirmPlanSteps(agent, parsed, signal, launch, () => { consumed = true })
  } catch (error) {
    // Aborted before the code was consumed: also invalidate the code so the
    // stopped confirmation can never be replayed later.
    if (launchSignal.aborted && !consumed) {
      await cancelPendingPlan(agent, parsed.confirmationCode).catch(() => {})
      throw Object.assign(new Error('已在开始执行前取消。'), { name: 'AbortError' })
    }
    throw error
  }
}

async function confirmPlanSteps(agent, parsed, signal, launch, markConsumed) {
  const launchSignal = launch.controller.signal
  const waitSignal = signal ? AbortSignal.any([signal, launchSignal]) : launchSignal
  const checkpoint = () => {
    if (launchSignal.aborted) throw Object.assign(new Error('已在开始执行前取消。'), { name: 'AbortError' })
  }
  // The slash command or the button that invokes it is the explicit
  // human authorization; the pending plan remains scoped and one-shot.
  checkpoint()
  await assertPlanCodeOpen(agent, parsed.confirmationCode)
  await assertNoActiveRun()
  const pendingPreview = await peekPendingPlan(agent)
  checkpoint()
  if (pendingPreview.workflowExecutionId) {
    if (Object.keys(parsed.overrides ?? {}).length > 0) throw new Error('目标工作流不接受任务面板参数覆盖；请编辑目标或工作流后重新生成。')
    const pending = await consumePlanFromHumanGesture(agent, parsed.confirmationCode)
    markConsumed()
    const execution = await startWorkflowExecution(agent, pending.workflowExecutionId, pending.goalId, pending.confirmationCode)
    return { kind: 'success', text: `目标工作流已开始（${execution.id}）。${workflowSummary(execution)}\n每一步只在 MAA 明确验证完成后继续；遇到人工决策、未知状态或预算风险会自动暂停。` }
  }
  await ensureMaaCli(waitSignal)
  checkpoint()
  const emulator = await checkEmulator({ runMaa, signal: waitSignal })
  checkpoint()
  if (!emulator.ok) throw new Error(emulatorErrorMessage(emulator))
  // Validate confirmation-time parameter overrides against the pending
  // document before consuming it, so a bad value never burns the code.
  const overrides = { ...(parsed.overrides ?? {}) }
  let note = ''
  if (overrides.note !== undefined) {
    note = decodeConfirmationNote(overrides.note)
    delete overrides.note
  }
  const hasOverrides = Object.keys(overrides).length > 0
  const peeked = hasOverrides || note ? await peekPendingPlan(agent) : null
  let confirmationDocument = peeked?.document
  let confirmationStrategy = peeked?.strategy
  let noteSummary = ''
  if (note) {
    const preview = peeked?.notePreview
    if (!preview || preview.status !== 'ready' || preview.note !== note) {
      throw new Error('备注尚未完成策略预览，或预览后又被修改。请先点击“解析并预览备注”。')
    }
    if (JSON.stringify(preview.overrides ?? {}) !== JSON.stringify(overrides)) {
      throw new Error('任务参数在备注预览后发生变化，请重新点击“解析并预览备注”。')
    }
    confirmationDocument = preview.document
    confirmationStrategy = preview.strategy
    noteSummary = `｜备注策略：${preview.supported.join('、')}${preview.unsupported.length ? `｜未执行：${preview.unsupported.map(item => item.request).join('、')}` : ''}`
    if (preview.adjustments?.length) noteSummary += `｜确认时调整：${preview.adjustments.join('、')}`
    try {
      const environment = await strategyEnvironment(signal)
      const committed = await applyStrategyMemory(confirmationStrategy, { ...environment, includeStored: false })
      confirmationStrategy = committed.strategy
      noteSummary += memorySummary(committed.memory)
    } catch (error) {
      noteSummary += `｜策略记忆未更新：${error instanceof Error ? error.message : String(error)}`
    }
  }
  const confirmationEnvironment = hasOverrides && !note ? await strategyEnvironment(signal) : null
  const patched = hasOverrides && !note ? applyTaskPanelOverrides(confirmationDocument, overrides, confirmationEnvironment.capabilities, panelContext(confirmationEnvironment)) : null
  const adjustments = patched && patched.applied.length > 0 ? `｜确认时调整：${patched.applied.join('、')}` : ''
  checkpoint()
  const pending = await consumePlanFromHumanGesture(agent, parsed.confirmationCode)
  markConsumed()
  const planSummary = `${pending.planSummary}${adjustments}${noteSummary}`
  const finalDocument = patched ? patched.document : (confirmationDocument ?? pending.document)
  // Remember what the human actually confirmed, so the next panel opens
  // with the same theme/difficulty/squad instead of MAA's defaults.
  await rememberConfirmedPanel(finalDocument, confirmationEnvironment).catch(() => {})
  // Keep the run label honest: the panel may have switched the theme at
  // confirm time, and the dock must not claim the old theme.
  const finalTheme = roguelikeThemeOf(finalDocument)
  const baseTheme = roguelikeThemeOf(pending.document)
  const purpose = finalTheme !== '' && baseTheme !== '' && finalTheme !== baseTheme
    ? `肉鸽 ${finalTheme}（确认时从 ${baseTheme} 切换）`
    : pending.purpose
  const result = await executeDocument(agent, signal, finalDocument, planSummary, {
    background: true, emulatorChecked: true, strategy: confirmationStrategy ?? pending.strategy, generatedFiles: pending.generatedFiles, purpose, confirmationCode: pending.confirmationCode,
    abortSignal: launchSignal,
    onRunStarted: run => {
      launch.runId = run.id
      void recordPlanRun(agent, pending.confirmationCode, run.id).catch(() => {})
    },
  })
  if (result.background) return { kind: 'success', text: formatBackgroundResult(result) }
  const text = formatCommandResult(result)
  return { kind: result.executionFeedback?.status !== 'failed' && !result.operatorBoxError ? 'success' : 'error', text }
}

function formatBackgroundResult(result) {
  return [
    `MAA 已开始执行（${result.runId}）。`,
    `计划：${result.planSummary}`,
    '任务在后台运行：确认面板会显示「执行中」和本地计时，需要中止时点击「停止任务」或输入 /maa stop；结束后点「查看执行记录」查看结果。',
    result.maintenanceWarning ?? '',
  ].filter(Boolean).join('\n')
}

export function apply(ctx) {
  // A new plugin process cannot prove that an in-flight step completed. Audit
  // persisted state immediately and clean only this plugin's generated task.
  if (restartRecoveryPromise === null) restartRecoveryPromise = recoverAfterRestart().catch(() => null)
  ctx.commands.register({
    name: 'maa',
    definitionId: 'dsh-maa-cli/maa',
    description: '直接运行常用 MAA 操作，不调用模型',
    input: { hint: '<startup | fight | infrast | recruit | mall | award | rouge | reclamation | update | closedown | help>' },
    async handler({ agent, rawInput, signal }) {
      try {
        const parsed = parseLocalMaaCommand(rawInput)
        if (parsed.kind === 'help') return { kind: 'success', text: parsed.text }
        if (parsed.kind === 'setup') {
          const steps = []
          await bootstrapRuntime({
            run: runMaa,
            signal,
            onStep: (id, detail) => steps.push({ id, detail }),
          })
          const status = await inspectRuntime()
          return {
            kind: status.installed ? 'success' : 'error',
            text: `${formatRuntimeReport(status)}${steps.length ? `\n\n${steps.map(step => `- ${step.id}：${step.detail}`).join('\n')}` : ''}`,
          }
        }
        if (parsed.kind === 'status') {
          // Read-only snapshot for the composer control panel. The client reads
          // this on demand (never polls): command-plane calls are echoed into
          // the transcript, so polling here would spam the conversation.
          return { kind: 'success', text: JSON.stringify(await sessionRunStatus(agent)) }
        }
        if (parsed.kind === 'cancel') {
          try {
            const cancelled = await cancelPendingPlan(agent, parsed.confirmationCode)
            if (cancelled.workflowExecutionId) await cancelPendingWorkflow(cancelled.workflowExecutionId, cancelled.goalId).catch(() => {})
            return {
              kind: 'success',
              text: cancelled.alreadyClosed
                ? `待确认计划 ${parsed.confirmationCode} 已经失效（${cancelled.status === 'expired' ? '超过有效期' : cancelled.status === 'superseded' ? '已被新计划替换' : '此前已取消'}），无需再次取消。`
                : `已取消待确认计划 ${cancelled.confirmationCode}；该确认码已失效。`,
            }
          } catch (error) {
            if (error?.code === 'MAA_PLAN_CONFIRMED') {
              // The plan already became a run (or is launching): point the panel
              // at it instead of pretending the plan was cancelled.
              const runId = error.closed?.runId || launches.get(agentKey(agent))?.runId || ''
              return { kind: 'error', text: `计划 ${parsed.confirmationCode} 已经确认并${runId ? `开始执行（${runId}）` : '正在启动'}，不能再取消；如需终止请停止任务。` }
            }
            throw error
          }
        }
        if (parsed.kind === 'runtime-instruction' && parsed.request.action === 'stop_now') {
          return formatStopOutcome(await stopExecution(agent, ''))
        }
        if (parsed.kind === 'runtime-instruction') {
          const result = await executeRuntimeInstruction(parsed.request, agent)
          return { kind: ['not_running', 'not_owned'].includes(result.status) ? 'error' : 'success', text: formatRuntimeInstructionResult(result) }
        }
        if (parsed.kind === 'stop') {
          const outcome = await stopExecution(agent, parsed.target ?? '')
          if (outcome.status !== 'not_running' || parsed.target) return formatStopOutcome(outcome)
          // Nothing recorded as running. A legacy maa-cli left behind by an
          // older version (no recorded pid) can still be cleaned by name.
          const reaped = await reapGeneratedTaskProcesses()
          return {
            kind: reaped.killed > 0 ? 'success' : 'error',
            text: reaped.killed > 0
              ? `已清理 ${reaped.killed} 个残留的 dsh-generated maa-cli 进程。`
              : '当前没有正在执行的 MAA 任务。',
          }
        }
        if (parsed.kind === 'peek') {
          // Read-only: the local client asks for the pending plan's MAA-style
          // field definitions and current values. Nothing is consumed here.
          const pending = await peekPendingPlan(agent)
          if (parsed.confirmationCode && parsed.confirmationCode !== pending.confirmationCode) {
            throw new Error('MAA 确认码与待确认计划不一致。')
          }
          const environment = await strategyEnvironment(signal)
          const workflow = pending.workflowExecutionId ? await getWorkflowExecution(pending.workflowExecutionId) : null
          const panel = workflow
            ? {
                type: 'Workflow', title: '目标工作流', fields: [], values: {},
                notes: workflow.steps.map((step, index) => ({ text: `${index + 1}. ${step.title}${step.kind === 'decision' ? '（到此暂停并请求人工决策）' : ''}` })),
              }
            : (pending.panelMemory === false
              // A plan prepared from the user's words is the authority: the
              // panel shows exactly what the model planned. Remembered values
              // only prefill the zero-model /maa panels.
              ? taskPanelFromDocument(pending.document, environment.capabilities, panelContext(environment))
              : await applyRememberedConfig(taskPanelFromDocument(pending.document, environment.capabilities, panelContext(environment)), { explicitKeys: pending.panelExplicitKeys }))
              ?? readOnlyPlanPanel(pending.document)
          return {
            kind: 'success',
            text: JSON.stringify({
              code: pending.confirmationCode,
              summary: pending.planSummary,
              theme: roguelikeThemeOf(pending.document),
              panel,
              capabilitySignature: environment.capabilities.signature,
              capabilitySource: environment.capabilities.source,
              capabilityWarning: environment.capabilities.warning ?? '',
              notePreview: publicNotePreview(pending.notePreview),
              goal: pending.goalPreview ?? null,
              workflow,
            }),
          }
        }
        if (parsed.kind === 'note-preview') {
          const preview = await prepareNotePreview(agent, parsed.confirmationCode, parsed.note, parsed.overrides, signal)
          return { kind: 'success', text: JSON.stringify(publicNotePreview(preview)) }
        }
        if (parsed.kind === 'strategies') {
          return { kind: 'success', text: JSON.stringify(await listStrategyMemory()) }
        }
        if (parsed.kind === 'strategy-enable' || parsed.kind === 'strategy-disable') {
          const changed = await setStrategyMemoryEnabled(parsed.id, parsed.kind === 'strategy-enable')
          return { kind: 'success', text: JSON.stringify(changed) }
        }
        if (parsed.kind === 'strategy-delete') {
          return { kind: 'success', text: JSON.stringify(await deleteStrategyMemory(parsed.id)) }
        }
        if (parsed.kind === 'confirm') {
          const key = agentKey(agent)
          const current = launches.get(key)
          if (current) {
            throw new Error(current.code === parsed.confirmationCode
              ? `计划 ${parsed.confirmationCode} 正在启动，请勿重复确认。`
              : `本会话正在启动另一个计划（${current.code}），请等待它开始或停止后再确认。`)
          }
          const launch = { code: parsed.confirmationCode, controller: new AbortController(), runId: '', settled: null }
          launches.set(key, launch)
          // Launch phases are serialized across ALL sessions: two confirmations
          // arriving together must not both pass the "no active run" check and
          // then have the loser's code burned without anything running.
          const confirmation = launchQueue.then(() => confirmPlan(agent, parsed, signal, launch))
          launchQueue = confirmation.catch(() => {})
          launch.settled = confirmation
          try {
            return await confirmation
          } catch (error) {
            if (error?.name === 'AbortError' && launch.controller.signal.aborted) {
              return { kind: 'error', text: launch.runId ? `任务已在启动阶段被停止（${launch.runId}）。` : `已在开始执行前取消（${parsed.confirmationCode}）；没有启动 MAA。` }
            }
            throw error
          } finally {
            if (launches.get(key) === launch) launches.delete(key)
          }
        }
        const environment = await strategyEnvironment(signal)
        let document = buildTaskDocument(parsed.steps, environment.capabilities)
        let summary = summarizePlan(parsed.steps, environment.capabilities, panelContext(environment))
        // Parameter adjustments are validated against the same whitelist the
        // confirmation panel uses, and a bad value aborts before anything is
        // written or executed.
        const overrides = parsed.roguelikeOverrides ?? {}
        if (Object.keys(overrides).length > 0) {
          const patched = applyTaskPanelOverrides(document, overrides, environment.capabilities, panelContext(environment))
          document = patched.document
          if (patched.applied.length > 0) summary = `${summary}｜参数：${patched.applied.join('、')}`
        }
        if (parsed.kind === 'plan') {
          // Every zero-model task only prepares: the client turns this notice
          // into its MAA-style parameter panel, and the button executes
          // `/maa confirm` on the local command plane. No model turn, no tokens.
          const pending = await preparePendingPlan(agent, {
            planSummary: summary, document,
            panelExplicitKeys: Array.isArray(parsed.panelExplicitKeys) ? parsed.panelExplicitKeys : [],
          })
          return {
            kind: 'success',
            text: `MAA 计划待确认：${summary}\n确认码 ${pending.confirmationCode}（30 分钟内有效）。参数面板已在输入框上方打开，确认后执行；也可以输入 /maa confirm ${pending.confirmationCode}。`,
          }
        }
        const result = await executeDocument(agent, signal, document, summary, { background: true })
        if (result.background) return { kind: 'success', text: formatBackgroundResult(result) }
        return { kind: result.executionFeedback?.status !== 'failed' && !result.operatorBoxError ? 'success' : 'error', text: formatCommandResult(result) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.tools.register({
    name: 'maa_query',
    description: 'Inspect the fixed local maa-cli installation without operating the game. Use for version, help, saved-task listing, and directory discovery.',
    parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: { operation: { type: 'string', enum: ['version', 'help', 'list', 'library_dir', 'resource_dir', 'config_dir', 'data_dir', 'log_dir', 'cache_dir', 'hot_update_dir'] } } },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(args, exec) { await requireMaaCli(); return await runMaa(queryArguments(args.operation), { signal: exec.signal, timeoutMs: 30_000 }) },
    presentCall: args => ({ card: 'terminal', title: `maa_query ${args.operation}` }),
  })

  ctx.tools.register({
    name: 'maa_runtime_instruction',
    description: 'Control or inspect the MAA task that is already running. Use this for runtime requests such as stop now, stop after the current roguelike exploration, stop before the next boss, stop before a numbered boss floor, stop after N more explorations, cancel a pending stop, query progress, or request a recruitment preference. Common requests are handled locally; temporary runtime instructions are never written to long-term strategy memory. A recruitment preference may return unsupported instead of pretending that maa-cli applied it live.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['stop_now', 'stop_after_current', 'stop_after_runs', 'stop_before_boss', 'stop_before_next_boss', 'cancel_stop', 'status', 'prefer_recruit'] },
        count: { type: 'integer', minimum: 1, maximum: 9999 },
        floor: { type: 'integer', minimum: 1, maximum: 99 },
        operator: { type: 'string', minLength: 1, maxLength: 20 },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, required: ['status'], properties: { status: { type: 'string' }, message: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: formatRuntimeInstructionResult(value) }],
    },
    async execute(args, exec) { return await executeRuntimeInstruction(args, exec?.agent ?? null) },
    presentCall: args => ({ card: 'terminal', title: `MAA 运行时指令：${args.action}` }),
  })

  ctx.tools.register({
    name: 'maa_operator_box',
    description: 'Read the locally cached Arknights operator roster without operating the emulator or game. Always call this before answering questions about which operators the user owns, rarity, elite level, level, or potential. Use rarity=6 for six-star questions. If available is false, or the user explicitly asks to refresh the data, prepare a confirmed StartUp + OperBox scan with maa_prepare_plan; never claim the roster from general knowledge.',
    parameters: {
      type: 'object', additionalProperties: false, properties: {
        rarity: { type: 'integer', minimum: 1, maximum: 6, description: 'Optional star-rarity filter.' },
        name: { type: 'string', description: 'Optional case-insensitive operator-name substring.' },
        eliteBelow: { type: 'integer', minimum: 1, maximum: 3, description: 'Optional filter: only operators whose elite level is lower than this value.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum returned operators; defaults to 200.' },
      },
    },
    output: {
      schema: OPERATOR_BOX_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.available
        ? `${value.summary}\n${value.operators.map(operator => `${operator.name}（${operator.rarity}星，精${operator.elite}，${operator.level}级，潜能${operator.potential}）`).join('、') || '没有匹配的干员。'}`
        : value.summary }],
    },
    async execute(args) { return queryOperatorBox(await readOperatorBox(), args) },
    presentCall: () => ({ card: 'terminal', title: '读取干员 Box 缓存' }),
  })

  ctx.tools.register({
    name: 'maa_depot',
    description: 'Read the last verified DepotInfo warehouse snapshot without operating the game. Use this before inventory or material-gap planning. If no cache exists, prepare a confirmed Depot scan instead of treating unknown inventory as zero.',
    parameters: { type: 'object', additionalProperties: false, properties: { itemId: { type: 'string' }, name: { type: 'string' } } },
    output: { schema: AGENT_RESULT_SCHEMA, render: renderAgentResult },
    async execute(args) {
      const snapshot = await readDepot()
      if (!snapshot) return agentResult({ status: 'needs_scan', summary: '尚无可靠仓库缓存；需要确认执行一次 Depot 扫描。' })
      const environment = await strategyEnvironment()
      const result = queryDepot(snapshot, await loadItemIndex(environment.resourceDir), args)
      return agentResult({ status: 'ready', summary: result.summary, data: result })
    },
    presentCall: () => ({ card: 'terminal', title: '读取仓库缓存' }),
  })

  ctx.tools.register({
    name: 'maa_goal_manager',
    description: 'Create and manage goal-driven Arknights plans. Use prepare for daily tasks, operator training, material gaps, or a custom multi-step target. Operator training covers elite/level, skill level 1-7, specializations and modules for one or several operators (operators[]); skill/mastery/module current levels are not in the Box scan and must be asked from the user, never assumed. Material gaps are planned jointly with Penguin Statistics ArkPlanner when reachable, otherwise per item. Use estimate for read-only “is my depot enough” questions. Operator training automatically refreshes cached game-data costs and Penguin Statistics drop rates at most once per 24 hours, then cross-checks them with the verified Box/Depot and current MAA stages. It applies explicit resource budgets and prepares a one-time confirmation; it never equates statistical expected drops, plan creation, or process exit with the game goal being achieved. Use replan after a scan or human decision, list/status to inspect, and cancel to stop a goal.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['prepare', 'replan', 'estimate', 'list', 'status', 'cancel', 'data_status', 'refresh_data'], description: 'estimate is read-only: compute training requirements and the remaining gap against the Depot cache without creating a goal (for “够不够/还缺什么” questions).' },
        goalId: { type: 'string' }, kind: { type: 'string', enum: ['daily', 'operator_training', 'materials', 'custom'] },
        title: { type: 'string' }, purpose: { type: 'string' }, operator: { type: 'string' }, completion: { type: 'string' },
        server: { type: 'string', enum: ['CN', 'US', 'JP', 'KR'], description: 'Game server used for drop-rate data; defaults to CN.' },
        targetElite: { type: 'integer', minimum: 0, maximum: 2, description: 'Operator target elite phase; defaults to 2.' },
        targetLevel: { type: 'integer', minimum: 1, maximum: 90, description: 'Level in the target elite phase; defaults to 1.' },
        skillLevel: TRAINING_TARGET_PROPERTIES.skillLevel, masteries: TRAINING_TARGET_PROPERTIES.masteries, modules: TRAINING_TARGET_PROPERTIES.modules,
        operators: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['operator'], properties: TRAINING_TARGET_PROPERTIES }, description: 'Several operator goals planned together; their material gaps are summed before planning.' },
        expandSynthesis: { type: 'boolean', description: 'Expand higher-tier materials into workshop ingredients after deducting stock (default false).' },
        budget: { type: 'object', additionalProperties: false, properties: { allowStone: { type: 'boolean' }, maxMedicine: { type: 'integer' }, maxExpiringMedicine: { type: 'integer' }, maxSanity: { type: 'integer' } } },
        requirements: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['quantity'], properties: { itemId: { type: 'string' }, name: { type: 'string' }, quantity: { type: 'integer' }, stage: { type: 'string' }, runs: { type: 'integer' } } } },
        steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['type'], properties: STEP_PROPERTIES } },
      },
    },
    output: { schema: AGENT_RESULT_SCHEMA, render: renderAgentResult },
    async execute(args, exec) {
      if (args.action === 'data_status' || args.action === 'refresh_data') {
        const data = args.action === 'refresh_data'
          ? await loadPlanningData({ server: args.server, signal: exec.signal, force: true })
          : await readPlanningData()
        if (!data) return agentResult({ status: 'missing', summary: '尚无培养/掉率缓存；首次准备培养目标时会自动下载。' })
        const metadata = { server: data.server, updatedAt: data.updatedAt, stale: data.stale, warning: data.warning, operatorCount: data.operators.length, matrixCount: data.matrix.length, sources: data.sources }
        return agentResult({ status: data.stale ? 'stale' : 'ready', summary: `培养/掉率数据：${data.server}，${data.updatedAt}，${data.operators.length} 条角色、${data.matrix.length} 条掉率记录${data.stale ? '（沿用缓存）' : ''}。`, data: metadata })
      }
      if (args.action === 'estimate') return await estimateTraining(args, exec.signal)
      if (args.action === 'prepare') {
        if (!args.kind) throw new Error('prepare 必须提供 kind。')
        return await prepareGoalConfirmation(args, exec)
      }
      if (args.action === 'list') {
        const goals = await listGoals()
        return agentResult({ status: 'ready', summary: goals.length ? `共有 ${goals.length} 个目标。` : '尚无目标。', data: goals })
      }
      const goal = await getGoal(args.goalId)
      if (!goal) throw new Error('找不到目标。')
      if (args.action === 'status') {
        const execution = goal.workflowExecutionId ? await getWorkflowExecution(goal.workflowExecutionId) : null
        return agentResult({ status: goal.status, goalId: goal.id, workflowId: execution?.id ?? '', summary: execution ? workflowSummary(execution) : `${goal.title}：${goal.status}`, data: { goal, execution } })
      }
      if (args.action === 'cancel') {
        const active = activeWorkflows.get(goal.workflowExecutionId)
        if (active) active.controller.abort()
        else if (goal.workflowExecutionId) await updateWorkflowExecution(goal.workflowExecutionId, current => {
          if (!['completed', 'failed', 'stopped', 'cancelled'].includes(current.status)) current.status = 'cancelled'
          current.needsUser = ''
          return current
        })
        await updateGoal(goal.id, { status: 'cancelled', needsUser: '' })
        return agentResult({ status: 'cancelled', goalId: goal.id, workflowId: goal.workflowExecutionId, summary: `已取消目标“${goal.title}”。` })
      }
      await assertNoActiveRun()
      const context = await goalPlanningContext(exec.signal, args.server ?? goal.request?.server, ['operator_training', 'materials'].includes(goal.kind))
      const request = { ...goal.request, ...Object.fromEntries(Object.entries(args).filter(([key]) => !['action', 'goalId'].includes(key))) }
      const plan = await planGoal(request, context)
      if (plan.status !== 'ready') {
        await updateGoal(goal.id, { status: 'needs_input', needsUser: plan.needsUser, facts: plan.facts, gaps: plan.gaps })
        return agentResult({ status: 'needs_input', goalId: goal.id, summary: plan.needsUser, data: plan })
      }
      if (goal.workflowExecutionId) {
        await updateWorkflowExecution(goal.workflowExecutionId, current => {
          if (current.status === 'pending_confirmation') current.status = 'superseded'
          return current
        }).catch(() => {})
      }
      const execution = await createWorkflowExecution({ goalId: goal.id, name: goal.title, steps: plan.steps, constraints: plan.constraints, capabilitySignature: context.capabilities.signature })
      await updateGoal(goal.id, { status: 'pending_confirmation', workflowExecutionId: execution.id, needsUser: '', facts: plan.facts, gaps: plan.gaps, completion: plan.completion, request })
      const summary = `${goal.title}｜重新规划为 ${execution.steps.length} 步`
      const confirmation = await preparePendingPlan(exec.agent, { purpose: goal.title, document: workflowDocument(execution), planSummary: summary, workflowExecutionId: execution.id, goalId: goal.id, goalPreview: { ...goal, steps: execution.steps } })
      exec.concludeTurn()
      return agentResult({ status: 'pending_confirmation', goalId: goal.id, workflowId: execution.id, summary, ...confirmation, data: { plan, execution } })
    },
    presentCall: args => ({ card: 'terminal', title: `目标管理：${args.action}` }),
  })

  ctx.tools.register({
    name: 'maa_workflow_manager',
    description: 'Save, edit, list, delete, inspect, and prepare reusable MAA workflow presets. Presets are validated against the current dynamic capability signature before execution; changed MAA resources require the preset to be reviewed and saved again.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'get', 'delete', 'prepare', 'status', 'cancel'] },
        id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
        steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['type'], properties: STEP_PROPERTIES } },
        constraints: { type: 'object', additionalProperties: false, properties: { allowStone: { type: 'boolean' }, maxMedicine: { type: 'integer' }, maxExpiringMedicine: { type: 'integer' }, maxSanity: { type: 'integer' } } },
      },
    },
    output: { schema: AGENT_RESULT_SCHEMA, render: renderAgentResult },
    async execute(args, exec) {
      if (args.action === 'list') return agentResult({ status: 'ready', summary: '已读取工作流预设。', data: await listWorkflowPresets() })
      if (args.action === 'get') {
        const value = await getWorkflowPreset(args.id)
        if (!value) throw new Error('找不到工作流预设。')
        return agentResult({ status: 'ready', workflowId: value.id, summary: `${value.name}：${value.steps.length} 步`, data: value })
      }
      if (args.action === 'delete') {
        const value = await deleteWorkflowPreset(args.id)
        if (!value) throw new Error('找不到工作流预设。')
        return agentResult({ status: 'deleted', workflowId: value.id, summary: `已删除预设“${value.name}”。` })
      }
      if (args.action === 'status' || args.action === 'cancel') {
        const execution = await getWorkflowExecution(args.id)
        if (!execution) throw new Error('找不到工作流执行记录。')
        if (args.action === 'cancel') {
          const active = activeWorkflows.get(execution.id)
          if (active) active.controller.abort()
          else await updateWorkflowExecution(execution.id, current => {
            if (!['completed', 'failed', 'stopped', 'cancelled'].includes(current.status)) current.status = 'cancelled'
            current.needsUser = ''
            return current
          })
          return agentResult({ status: 'cancelled', workflowId: execution.id, summary: `已取消工作流“${execution.name}”。` })
        }
        return agentResult({ status: execution.status, workflowId: execution.id, summary: workflowSummary(execution), data: execution })
      }
      const environment = await strategyEnvironment(exec.signal)
      if (args.action === 'save') {
        const document = buildTaskDocument(args.steps, environment.capabilities)
        const preset = await saveWorkflowPreset({ id: args.id, name: args.name, description: args.description, constraints: args.constraints, capabilitySignature: environment.capabilities.signature, steps: document.tasks.map((task, index) => ({ id: `preset-${index + 1}`, kind: 'maa', title: `${index + 1}. ${task.type}`, maa: task })) })
        return agentResult({ status: 'saved', workflowId: preset.id, summary: `已保存工作流“${preset.name}”（${preset.steps.length} 步）。`, data: preset })
      }
      await assertNoActiveRun()
      const preset = await getWorkflowPreset(args.id)
      if (!preset) throw new Error('找不到工作流预设。')
      if (preset.capabilitySignature !== environment.capabilities.signature) throw new Error('MAA 版本或资源已变化，工作流预设需要重新检查并保存后才能执行。')
      const execution = await createWorkflowExecution({ presetId: preset.id, name: preset.name, steps: preset.steps, constraints: preset.constraints, capabilitySignature: preset.capabilitySignature })
      const summary = `工作流预设：${preset.name}｜${execution.steps.length} 步`
      const confirmation = await preparePendingPlan(exec.agent, { purpose: preset.name, document: workflowDocument(execution), planSummary: summary, workflowExecutionId: execution.id })
      exec.concludeTurn()
      return agentResult({ status: 'pending_confirmation', workflowId: execution.id, summary, ...confirmation, data: execution })
    },
    presentCall: args => ({ card: 'terminal', title: `工作流管理：${args.action}` }),
  })

  ctx.tools.register({
    name: 'maa_training_advice',
    description: 'MANDATORY for every operator training-advice request: call this tool before answering and never replace, approximate, or complete its strategy from model knowledge. On the user\'s first advice request, ALWAYS call with useCached=false: if a cache exists, present the returned choice and ask whether to use it or rescan; if no cache exists, guide the user to a confirmed StartUp + OperBox scan. Call again with useCached=true only after the user explicitly chooses the cache, or answers yes to the advice question immediately following a completed scan. If this tool is unavailable or fails to load, clearly state the reason, suggest restarting DSH Desktop and checking the dsh-maa-cli installation, and do not claim that the full strategy ran. Prefer existing Box and ranking caches; do not perform unnecessary recursive searches or repeated scans. Ratings come from the latest published ArknightsVote community result; professions come from the installed MAA resource. Never invent missing ratings or profession ranks.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['useCached'],
      properties: {
        useCached: { type: 'boolean', description: 'false for the initial request; true only after the user explicitly accepts the cached scan.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum recommendations; defaults to 10.' },
      },
    },
    output: {
      schema: TRAINING_ADVICE_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.status === 'ready' ? formatTrainingAdvice(value) : value.summary }],
    },
    async execute(args, exec) {
      const snapshot = await readOperatorBox()
      if (snapshot === null) {
        return {
          status: 'needs_scan', scannedAt: '',
          summary: '尚无干员 Box 缓存。请先准备并确认一次 StartUp + OperBox 扫描；扫描完成后会主动询问是否需要培养建议。',
        }
      }
      if (args.useCached !== true) {
        return {
          status: 'needs_choice', scannedAt: snapshot.scannedAt,
          summary: `发现上次 Box 缓存（扫描时间：${snapshot.scannedAt}，共 ${snapshot.operators.length} 名干员）。请询问用户：直接使用这份缓存生成培养建议，还是重新扫描？重新扫描会操作游戏，必须另行确认。`,
        }
      }
      try {
        await requireMaaCli()
        const directory = await runMaa(queryArguments('resource_dir'), { signal: exec.signal, timeoutMs: 30_000 })
        const resourceDirectory = directory.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
        if (directory.exitCode !== 0 || !resourceDirectory) throw new Error(`无法读取 MAA 资源目录：${directory.stderr || directory.stdout || `exit ${directory.exitCode}`}`)
        const [metadata, ranking] = await Promise.all([
          loadOperatorMetadata(resourceDirectory),
          fetchCommunityRanking({ signal: exec.signal }),
        ])
        return buildTrainingAdvice(snapshot, metadata, ranking, { maxResults: args.maxResults })
      } catch (error) {
        return {
          status: 'source_error', scannedAt: snapshot.scannedAt,
          summary: `无法在不编造数据的前提下生成培养建议：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
    presentCall: () => ({ card: 'terminal', title: '读取 Box 并生成培养建议' }),
  })

  ctx.tools.register({
    name: 'maa_prepare_plan',
    description: `Prepare, validate, and preview an ordered MaaCore plan from the user's natural-language Arknights request, but DO NOT operate the game. Always use this tool first for a game action. Decompose the request into 1-20 steps. Supported steps: StartUp, Fight, Infrast, Recruit, Mall, Award, Roguelike, ReclamationAlgorithm, Depot, OperBox, Custom existing MaaCore task names, CloseDown. Fight requires finite times (1-100) unless drops is given; use drops for "刷到 N 个 X" requests and stage "Annihilation" for 剿灭 (the plugin cannot know whether this week's annihilation is already maxed, never claim it). For "today's resource/chip stage" call maa_stage_schedule first to learn which weekly stages are open. Recruit.times is how many recruitments to START (1-4, default 4); 0 only recognizes tags. Recruit.confirm lists the star levels MAA actually starts (default [3,4] like the MAA GUI; an empty list means recognize only). Never add 5 or 6 to confirm unless the user explicitly asks: 5★/6★ slots are skipped for the player and reported after the run. Custom base schedules use maa_prepare_infrast and copilot-site jobs use maa_copilot, not this tool; only give the total times: there is no series field, the plugin always lets MaaCore group battles automatically (series 0). Roguelike requires startsCount (1-99999; the confirmation panel starts at 9999). Never infer permission to spend resources: medicine, expiringMedicine, stone, Recruit expedite, Mall shopping, reward mail/freePull/event options, drones, or reclamation crafting remain disabled/default unless explicitly requested. If ambiguous, ask before preparing. This tool ends the current turn and returns a one-time local confirmation button; when the plan contains a Roguelike step the confirmation UI also shows MAA-style roguelike settings — theme, mode, difficulty, squad, role group, starting operator and MAA's advanced switches — pre-filled from MAA's recommended opening (marked 【推荐】 and freely editable), so the user may adjust there without re-preparing the plan; a 备注 field next to the validity hint is handed back to DSH as free-form guidance that DSH may act on but is not guaranteed to. Clicking confirm executes through the non-model command plane and does not create another model call.`,
    parameters: {
      type: 'object', additionalProperties: false, required: ['purpose', 'steps'],
      properties: {
        purpose: { type: 'string', description: 'Short Chinese summary of the user request.' },
        steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['type'], properties: STEP_PROPERTIES } },
      },
    },
    output: { schema: PREPARE_RESULT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      await assertNoActiveRun()
      const environment = await strategyEnvironment(exec.signal)
      const steps = resolveStepDrops(args.steps, environment.itemIndex)
      const document = buildTaskDocument(steps, environment.capabilities)
      let memory
      try {
        memory = await rememberPlanStrategies(steps, environment.compatibility, { capabilities: environment.capabilities })
      } catch (error) {
        memory = memoryFallback(error, steps.length)
      }
      const warnings = await weeklyStageWarnings(steps, environment.resourceDir).catch(() => [])
      const planSummary = `${summarizePlan(steps, environment.capabilities, panelContext(environment))}${warnings.length ? `｜⚠ ${warnings.join('；')}` : ''}${memorySummary(memory)}`
      const planJson = `${JSON.stringify(document, null, 2)}\n`
      const confirmation = await preparePendingPlan(exec.agent, { purpose: args.purpose, document, planJson, planSummary, panelMemory: false })
      exec.concludeTurn()
      return { purpose: args.purpose, planJson, planSummary, confirmationCode: confirmation.confirmationCode, confirmationPhrase: confirmation.confirmationPhrase, expiresAt: confirmation.expiresAt, memory }
    },
    presentCall: args => ({ card: 'terminal', title: `准备MAA计划：${args.purpose}` }),
  })

  ctx.tools.register({
    name: 'maa_prepare_strategy',
    description: `Compile a user's free-form, multi-intent MAA strategy into real Integrated Strategy resource changes or a real Copilot job, then prepare the existing one-time confirmation flow. Use this instead of maa_prepare_plan when the request changes operator recruitment/E2 priorities, team-completeness conditions, collectible purchase/ban priorities, encounter choices, theme-specific strategy, tactical placement (including guarding the blue box or blocking the entrance), deployment order/location/direction, or kill-count-triggered actions. The model translates synonyms and context into these structured fields; the plugin validates them against the installed MAA resources. Never invent an operator group, collectible, event, map coordinate, or successful execution. Put any part that cannot be represented reliably in unsupportedRequirements with a concrete reason; supported parts may still run after confirmation. Roguelike resource files are changed only for the confirmed execution and are restored afterward (and recovered on the next run after interruption). Copilot coordinates use [x,y], actions run in array order, and kills is the MAA kill-count wait condition. This tool only prepares; it never operates the game until the user confirms.` ,
    parameters: {
      type: 'object', additionalProperties: false, required: ['purpose', 'kind', 'task'],
      properties: {
        purpose: { type: 'string' },
        kind: { type: 'string', enum: ['Roguelike', 'Copilot'] },
        task: {
          type: 'object', additionalProperties: false,
          properties: {
            theme: { type: 'string', description: 'Theme id discovered from the active MAA resources; the server validates it before preparation.' },
            mode: { type: 'integer' }, startsCount: { type: 'integer' }, difficulty: { type: 'integer' },
            squad: { type: 'string' }, coreChar: { type: 'string' }, roles: { type: 'string' },
            useSupport: { type: 'boolean' }, useNonFriendSupport: { type: 'boolean' },
            stageName: { type: 'string' }, formation: { type: 'boolean' },
          },
        },
        recruitment: {
          type: 'object', additionalProperties: false, properties: {
            prioritize: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, priority: { type: 'integer' }, skill: { type: 'integer' } } } },
            promote: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, priority: { type: 'integer' } } } },
            teamComplete: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['groups', 'threshold'], properties: { groups: { type: 'array', items: { type: 'string' } }, threshold: { type: 'integer' } } } },
          },
        },
        shopping: {
          type: 'object', additionalProperties: false, properties: {
            prioritize: { type: 'array', items: { type: 'string' } }, avoid: { type: 'array', items: { type: 'string' } },
          },
        },
        encounters: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'choose'], properties: { name: { type: 'string' }, choose: { type: 'integer' }, optionCount: { type: 'integer' } } } },
        operators: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, skill: { type: 'integer' }, skillUsage: { type: 'integer' }, skillTimes: { type: 'integer' } } } },
        groups: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'opers'], properties: { name: { type: 'string' }, opers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, skill: { type: 'integer' }, skillUsage: { type: 'integer' }, skillTimes: { type: 'integer' } } } } } } },
        tactics: {
          type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['kind', 'name'], properties: {
              kind: { type: 'string', enum: ['guard_blue', 'block_entrance'] }, name: { type: 'string' }, kills: { type: 'integer' },
              stageName: { type: 'string', description: 'Roguelike only: autopilot stage name whose deploy_plan is edited. Omit it to apply the tactic to every native autopilot stage, with positions derived from the MAA map data.' },
              location: { type: 'array', items: { type: 'integer' }, description: 'Roguelike only: [x, y] deploy tile, only used when a stage is named; derived from the map data otherwise.' },
              direction: { type: 'string', description: 'Roguelike only: facing such as 下/上/左/右/down/up/left/right, only used when a stage is named.' },
            },
          },
        },
        actions: {
          type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['type'], properties: {
              type: { type: 'string', enum: ['Deploy', 'Skill', 'Retreat', 'SpeedUp', 'BulletTime', 'SkillUsage', 'Output', 'SkillDaemon', 'ResetStopwatch', 'SetUnitLocation'] },
              name: { type: 'string' }, location: { type: 'array', items: { type: 'integer' } }, direction: { type: 'string' },
              kills: { type: 'integer' }, costs: { type: 'integer' }, preDelay: { type: 'integer' }, postDelay: { type: 'integer' }, timeout: { type: 'integer' },
              skillUsage: { type: 'integer' }, skillTimes: { type: 'integer' },
            },
          },
        },
        unsupportedRequirements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['request', 'reason'], properties: { request: { type: 'string' }, reason: { type: 'string' } } } },
      },
    },
    output: { schema: STRATEGY_PREPARE_RESULT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      await assertNoActiveRun()
      let strategy = compileStrategyRequest(args)
      const environment = await strategyEnvironment(exec.signal)
      const { resourceDir, compatibility: compatibilityResult, capabilities } = environment
      if (!capabilities.roguelike.themes.some(theme => strategy.kind !== 'Roguelike' || theme.id === strategy.theme)) {
        throw new Error(`当前 MAA 资源不支持肉鸽主题 ${strategy.theme}`)
      }
      let memory
      try {
        const applied = await applyStrategyMemory(strategy, { resourceDir, compatibility: compatibilityResult })
        strategy = applied.strategy
        memory = applied.memory
      } catch (error) {
        memory = memoryFallback(error, 1)
      }
      const preview = await previewStrategy(strategy, resourceDir)
      const document = strategy.kind === 'Roguelike'
        ? buildTaskDocument([strategy.step], capabilities)
        : { tasks: [{ type: 'Copilot', params: { filename: GENERATED_COPILOT_MARKER, formation: strategy.formation } }] }
      const fallback = preview.unsupported.length ? `｜安全回退：${preview.unsupported.map(item => item.request).join('、')}` : ''
      const planSummary = `${args.purpose}｜生效：${preview.supported.join('、')}${fallback}${memorySummary(memory)}`
      const planJson = `${JSON.stringify(document, null, 2)}\n`
      const confirmation = await preparePendingPlan(exec.agent, { purpose: args.purpose, document, planJson, planSummary, strategy, panelMemory: false })
      exec.concludeTurn()
      return {
        purpose: args.purpose, planJson, planSummary,
        confirmationCode: confirmation.confirmationCode, confirmationPhrase: confirmation.confirmationPhrase, expiresAt: confirmation.expiresAt,
        supported: preview.supported, unsupported: preview.unsupported, memory,
      }
    },
    presentCall: args => ({ card: 'terminal', title: `编译MAA策略：${args.purpose}` }),
  })

  ctx.tools.register({
    name: 'maa_prepare_note',
    description: `Use this when the MAA task-panel note was reported as unresolved by the local rules. First identify the subject (operator, collectible or event name; correct typos and aliases) and the verb (抓/拿/捞/取/选/选择/招募 all mean recruit), then rewrite the note into short canonical Chinese and pass it here. The local parser and compiler re-validate every intent against the installed MAA resources and prepare the existing one-time confirmation flow. Do not call maa_prepare_strategy directly for such a note, do not invent operators, collectibles, groups, stage names or coordinates, and never claim the game was operated. Unrepresentable intents are returned in unsupported with a concrete reason; language that is still ambiguous returns status "needs_model" with unresolved clauses so you can ask the user. This tool only prepares the plan; it never executes it.`,
    parameters: {
      type: 'object', additionalProperties: false, required: ['note'],
      properties: {
        note: { type: 'string', description: 'Canonicalized Chinese note, 1-120 characters, e.g. 优先招募结城理，并在暗箭难防让结城理堵门 [3,1] 朝下' },
        purpose: { type: 'string', description: 'Short purpose label for the confirmation card; defaults to 备注策略：<note>' },
        confirmationCode: { type: 'string', description: 'Optional confirmation code of the panel being edited; defaults to the latest pending plan of this session.' },
        theme: { type: 'string', description: 'Roguelike theme id of the panel being edited (e.g. BlackFlow). Pass it so the note lands on that theme instead of whichever plan is latest in the session.' },
        mode: { type: 'integer', description: 'Optional Roguelike mode of the panel being edited; defaults to the pending plan value.' },
      },
    },
    output: { schema: NOTE_PREPARE_RESULT_SCHEMA, render: renderNoteResult },
    async execute(args, exec) {
      await assertNoActiveRun()
      const note = String(args.note ?? '').replace(/[\r\n\t]+/gu, ' ').trim()
      if (note === '') throw new Error('备注不能为空。')
      if (note.length > 120) throw new Error('备注最多 120 个字符。')
      const pending = await peekPendingPlan(exec.agent)
      if (!pending) throw new Error('当前没有待确认计划；请先用 maa_prepare_plan 打开任务面板。')
      if (args.confirmationCode && args.confirmationCode !== pending.confirmationCode) throw new Error('MAA 确认码与待确认计划不一致。')
      const theme = typeof args.theme === 'string' ? args.theme.trim() : ''
      const pendingTheme = roguelikeThemeOf(pending.document)
      const contextPending = theme
        ? { confirmationCode: pending.confirmationCode, strategy: { kind: 'Roguelike', step: { theme, ...(Number.isInteger(args.mode) ? { mode: args.mode } : {}) } } }
        : pending
      const parsed = await parseStrategyNote(note, contextPending)
      if (parsed.needsModel) {
        return { status: 'needs_model', note, recognized: parsed.recognized, unresolved: parsed.unresolved, modelPrompt: noteModelPrompt(parsed) }
      }
      if (!parsed.input) throw new Error('备注没有可编译的策略。')
      const environment = await strategyEnvironment(exec.signal)
      const strategy = compileStrategyRequest(parsed.input)
      if (!environment.capabilities.roguelike.themes.some(theme => strategy.kind !== 'Roguelike' || theme.id === strategy.theme)) {
        throw new Error(`当前 MAA 资源不支持肉鸽主题 ${strategy.theme}`)
      }
      let memory
      let applied = strategy
      try {
        const result = await applyStrategyMemory(strategy, { resourceDir: environment.resourceDir, compatibility: environment.compatibility })
        applied = result.strategy
        memory = result.memory
      } catch (error) {
        memory = memoryFallback(error, 1)
      }
      const preview = await previewStrategyDetails(applied, environment.resourceDir)
      const themeShifted = applied.kind === 'Roguelike' && theme !== '' && theme !== pendingTheme
      if (themeShifted) {
        preview.supported.unshift(`按面板主题 ${theme} 重建任务，未沿用会话里的 ${pendingTheme || '其他主题'} 计划`)
      }
      const document = themeShifted
        ? buildTaskDocument([applied.step], environment.capabilities)
        : documentWithNoteStrategy(pending.document, applied)
      const purpose = String(args.purpose ?? '').trim()
        || (applied.kind === 'Roguelike' ? `肉鸽 ${applied.step.theme}：${note.slice(0, 48)}` : `备注策略：${note.slice(0, 60)}`)
      const fallback = preview.unsupported.length ? `｜安全回退：${preview.unsupported.map(item => item.request).join('、')}` : ''
      const planSummary = `${purpose}｜生效：${preview.supported.join('、')}${fallback}${memorySummary(memory)}`
      const planJson = `${JSON.stringify(document, null, 2)}\n`
      const panelNote = pending.notePreview?.note ?? note
      const notePreview = {
        status: 'ready', note: panelNote, recognized: parsed.recognized,
        supported: preview.supported, unsupported: preview.unsupported, changes: preview.changes,
        memory, strategy: applied, document, overrides: {}, adjustments: [],
      }
      const confirmation = await preparePendingPlan(exec.agent, { purpose, document, planJson, planSummary, strategy: applied, notePreview, panelMemory: false })
      exec.concludeTurn()
      return {
        status: 'ready', note, purpose, planJson, planSummary,
        confirmationCode: confirmation.confirmationCode, confirmationPhrase: confirmation.confirmationPhrase, expiresAt: confirmation.expiresAt,
        supported: preview.supported, unsupported: preview.unsupported, memory, recognized: parsed.recognized,
      }
    },
    presentCall: args => ({ card: 'terminal', title: `识别备注：${args.note}` }),
  })

  ctx.tools.register({
    name: 'maa_stage_schedule',
    description: 'Read-only: report which weekly resource and chip stages (e.g. CE/LS/CA/AP/SK, PR-*) are open today in game-server time (the day starts at 04:00). The weekly schedule comes from the cached ArknightsGamedata zone table and the stage list from the installed MAA stages.json. Use it before preparing a Fight for requests like “今天开了哪个芯片本就刷哪个”. It does not cover limited-time event stages and never operates the game.',
    parameters: {
      type: 'object', additionalProperties: false, properties: {
        server: { type: 'string', enum: ['CN', 'US', 'JP', 'KR'], description: 'Game server; defaults to CN.' },
        kind: { type: 'string', enum: ['all', 'chip', 'resource'], description: 'Filter: chip stages, resource stages, or all (default).' },
        refresh: { type: 'boolean', description: 'Force a data refresh instead of the 24-hour cache.' },
      },
    },
    output: { schema: AGENT_RESULT_SCHEMA, render: renderAgentResult },
    async execute(args, exec) {
      const environment = await strategyEnvironment(exec.signal)
      const [data, stages] = await Promise.all([
        loadPlanningData({ server: args.server, signal: exec.signal, force: args.refresh === true }),
        readMaaStages(environment.resourceDir),
      ])
      const schedule = weeklyStageSchedule(data, stages, { server: args.server ?? data.server })
      const zones = schedule.zones.filter(zone => !args.kind || args.kind === 'all' || zone.kind === args.kind)
      const open = zones.filter(zone => zone.openToday === true)
      const closed = zones.filter(zone => zone.openToday === false)
      const unknown = zones.filter(zone => zone.openToday === null)
      const line = zone => `${zone.name}（${zone.kind === 'chip' ? '芯片' : '资源'}）：${zone.stages.join('、')}`
      const summary = [
        `${schedule.server} 服今天是${WEEKDAY_LABELS[schedule.weekday]}（以服务器时间 04:00 为日界）。`,
        open.length ? `今天开放：\n${open.map(line).join('\n')}` : '没有找到今天开放的周常关卡。',
        closed.length ? `今天未开放：${closed.map(zone => `${zone.name}（${zone.daysOfWeek.map(day => WEEKDAY_LABELS[day]).join('/')}）`).join('、')}` : '',
        unknown.length ? `开放日未知：${unknown.map(zone => zone.name).join('、')}` : '',
        data.stale ? data.warning : '',
        '限时活动关卡与“资源全开放”活动不在此统计内；开放情况以游戏内为准。',
      ].filter(Boolean).join('\n')
      return agentResult({ status: data.stale ? 'stale' : 'ready', summary, data: { ...schedule, zones } })
    },
    presentCall: () => ({ card: 'terminal', title: '查询今日开放关卡' }),
  })

  const INFRAST_ROOM_SCHEMA = {
    type: 'array', maxItems: 5, items: {
      type: 'object', additionalProperties: false, properties: {
        operators: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'Operator names in the client language (Chinese for CN). Unknown names are dropped with a reason.' },
        candidates: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'Fallback operators picked in order until the room is full; not combined with autofill.' },
        product: { type: 'string', description: 'Manufacturing: 赤金/作战记录/芯片/源石碎片; trading: 龙门币/合成玉. Tells MAA what the room currently produces so it picks matching operators; MAA does NOT switch the production line.' },
        autofill: { type: 'boolean', description: 'Fill remaining slots with MAA\'s default algorithm. Empty operators implies autofill.' },
        skip: { type: 'boolean', description: 'Do not change operators in this room.' },
        sort: { type: 'boolean', description: 'Keep the given operator order.' },
        count: { type: 'integer', minimum: 1, maximum: 5, description: 'Repeat this room definition for N rooms of this kind, e.g. all manufacturing stations.' },
      },
    },
  }

  ctx.tools.register({
    name: 'maa_prepare_infrast',
    description: 'Prepare a custom base schedule (MAA Infrast mode 10000) from the user\'s natural-language base arrangement, e.g. “制造站全部放赤金，红云放贸易站”. Translate the request into plans[].rooms; the plugin validates operator names against MAA\'s battle_data.json, generates MAA\'s base-scheduling JSON, shows a preview and returns a one-time confirmation. Rooms not mentioned keep MAA\'s default algorithm. MAA cannot change what a factory produces: product only describes the current product. Use action list/delete to manage schedules saved with saveAs, and useSaved to run one again. This tool never operates the game before confirmation.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['prepare', 'list', 'delete'] },
        purpose: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
        plans: {
          type: 'array', minItems: 1, maxItems: 6, items: {
            type: 'object', additionalProperties: false, required: ['rooms'], properties: {
              name: { type: 'string' }, description: { type: 'string' },
              period: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Optional [["hh:mm","hh:mm"]] ranges in which this plan is chosen.' },
              rooms: {
                type: 'object', additionalProperties: false, properties: {
                  control: INFRAST_ROOM_SCHEMA, manufacture: INFRAST_ROOM_SCHEMA, trading: INFRAST_ROOM_SCHEMA, power: INFRAST_ROOM_SCHEMA,
                  meeting: INFRAST_ROOM_SCHEMA, hire: INFRAST_ROOM_SCHEMA, dormitory: INFRAST_ROOM_SCHEMA, processing: INFRAST_ROOM_SCHEMA,
                },
              },
              drones: { type: 'object', additionalProperties: false, properties: { room: { type: 'string', enum: ['trading', 'manufacture'] }, index: { type: 'integer', minimum: 1, maximum: 5 }, order: { type: 'string', enum: ['pre', 'post'] } } },
              fiammetta: { type: 'object', additionalProperties: false, properties: { target: { type: 'string' }, order: { type: 'string', enum: ['pre', 'post'] } } },
            },
          },
        },
        facilities: { type: 'array', items: { type: 'string', enum: ['Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Dorm', 'Processing'] }, description: 'Facilities MAA processes; defaults to all standard facilities.' },
        planIndex: { type: 'integer', minimum: 0, maximum: 5, description: 'Which plan to run now (0-based); defaults to 0.' },
        saveAs: { type: 'string', description: 'Also save the compiled schedule under this name.' },
        useSaved: { type: 'string', description: 'Prepare a previously saved schedule instead of plans.' },
        name: { type: 'string', description: 'For delete: saved schedule name.' },
      },
    },
    output: { schema: AGENT_RESULT_SCHEMA, render: renderAgentResult },
    async execute(args, exec) {
      if (args.action === 'list') {
        const saved = await listSavedInfrastPlans()
        return agentResult({ status: 'ready', summary: saved.length ? `已保存 ${saved.length} 个排班：${saved.map(item => item.name).join('、')}` : '还没有保存的排班。', data: saved.map(item => ({ name: item.name, savedAt: item.savedAt, plans: describeInfrastPlan(item.document) })) })
      }
      if (args.action === 'delete') {
        const removed = await deleteInfrastPlan(String(args.name ?? ''))
        return agentResult({ status: removed ? 'deleted' : 'missing', summary: removed ? `已删除排班“${args.name}”。` : `没有名为“${args.name}”的排班。` })
      }
      await assertNoActiveRun()
      const environment = await strategyEnvironment(exec.signal)
      let compiled
      if (args.useSaved) {
        const saved = (await listSavedInfrastPlans()).find(item => item.name === args.useSaved)
        if (!saved) throw new Error(`没有名为“${args.useSaved}”的已保存排班。`)
        compiled = { document: saved.document, facilities: saved.facilities, supported: describeInfrastPlan(saved.document), unsupported: [], notes: [], warnings: ownershipWarnings(saved.document, await readOperatorBox()) }
      } else {
        compiled = compileInfrastPlan(args, await loadOperatorNames(environment.resourceDir), { box: await readOperatorBox() })
      }
      const planIndex = args.planIndex ?? 0
      if (planIndex >= compiled.document.plans.length) throw new Error(`排班只有 ${compiled.document.plans.length} 个方案，planIndex 超出范围。`)
      const saved = args.saveAs && !args.useSaved ? await saveInfrastPlan(args.saveAs, compiled) : null
      const marker = generatedFileMarker('infrast')
      const steps = [{ type: 'Infrast', mode: 10000, filename: marker, planIndex, facilities: compiled.facilities }]
      const document = buildTaskDocument(steps, environment.capabilities)
      const purpose = args.purpose || args.title || '基建自定义排班'
      const parts = [`${purpose}｜执行方案 ${planIndex}：${describeInfrastPlan(compiled.document)[planIndex]}`]
      if (compiled.unsupported.length) parts.push(`未执行：${compiled.unsupported.map(item => `${item.request}（${item.reason}）`).join('、')}`)
      if (compiled.warnings.length) parts.push(`⚠ ${compiled.warnings.join('；')}`)
      if (compiled.notes.length) parts.push(`注意：${compiled.notes.join('；')}`)
      if (saved) parts.push(`已保存为“${saved.name}”`)
      const planSummary = parts.join('｜')
      const planJson = `${JSON.stringify(document, null, 2)}\n`
      const confirmation = await preparePendingPlan(exec.agent, { purpose, document, planJson, planSummary, generatedFiles: [{ marker, content: compiled.document }], panelMemory: false })
      exec.concludeTurn()
      return agentResult({ status: 'pending_confirmation', summary: planSummary, ...confirmation, data: { schedule: compiled.document, supported: compiled.supported, unsupported: compiled.unsupported } })
    },
    presentCall: args => ({ card: 'terminal', title: args.action === 'prepare' ? `准备基建排班：${args.purpose || args.title || args.useSaved || ''}` : `基建排班：${args.action}` }),
  })

  ctx.tools.register({
    name: 'maa_copilot',
    description: 'Find and run community copilot jobs from the MAA copilot site (prts.plus). action=search is read-only: it queries the site by stage (e.g. H8-4, 1-7) and ranks jobs by whether the verified OperBox cache owns the required operators, listing missing ones; without a Box cache it says ownership is unknown. action=prepare downloads one job (copilotId, maa://ID accepted), shows title/author/operators/missing operators and returns a one-time confirmation that runs it through MaaCore Copilot (or SSSCopilot for 保全派驻 jobs). Never claim a job will succeed; low-level jobs may still fail. Sanity potions are not used unless explicitly requested.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['search', 'prepare'] },
        stage: { type: 'string', description: 'Stage code to search for, or to navigate to when preparing.' },
        operator: { type: 'string', description: 'search: only jobs that use this operator.' },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
        copilotId: { type: 'string', description: 'prepare: job id from search, e.g. 12345 or maa://12345.' },
        navigate: { type: 'boolean', description: 'prepare: let MAA navigate to the stage (default true when the stage code is known); false runs on the stage currently open in the game.' },
        formation: { type: 'boolean', description: 'Auto formation (default true).' },
        addTrust: { type: 'boolean' }, supportUnitUsage: { type: 'integer', minimum: 0, maximum: 3 },
        loopTimes: { type: 'integer', minimum: 1, maximum: 99 }, useSanityPotion: { type: 'boolean' },
        purpose: { type: 'string' },
      },
    },
    output: { schema: AGENT_RESULT_SCHEMA, render: renderAgentResult },
    async execute(args, exec) {
      const box = await readOperatorBox()
      if (args.action === 'search') {
        const ranked = rankCopilots(await searchCopilots({ stage: args.stage, operator: args.operator, limit: args.limit }, { signal: exec.signal }), box)
        const summary = ranked.length
          ? [`作业站 ${args.stage} 共返回 ${ranked.length} 份作业${box ? `（已按 ${box.scannedAt} 的 Box 缓存标注缺少的干员）` : '（没有 Box 缓存，无法判断是否缺干员）'}：`, ...ranked.map(formatCopilotCandidate)].join('\n')
          : `作业站没有找到 ${args.stage} 的作业。`
        return agentResult({ status: 'ready', summary, data: ranked.map(({ content: _content, ...item }) => item) })
      }
      await assertNoActiveRun()
      const environment = await strategyEnvironment(exec.signal)
      const [item] = rankCopilots([await getCopilot(args.copilotId, { signal: exec.signal })], box)
      const job = item.job
      const stageCode = [args.stage, job.stageName].map(value => String(value ?? '').trim()).find(value => /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/u.test(value)) ?? ''
      const marker = generatedFileMarker(`copilot-site-${item.id}`)
      const step = job.kind === 'SSSCopilot'
        ? { type: 'SSSCopilot', filename: marker, loopTimes: args.loopTimes ?? 1 }
        : {
            type: 'Copilot', filename: marker,
            ...(args.navigate !== false && stageCode ? { stageName: stageCode } : { loopTimes: args.loopTimes ?? 1 }),
            formation: args.formation !== false, addTrust: args.addTrust === true,
            supportUnitUsage: args.supportUnitUsage ?? 0, useSanityPotion: args.useSanityPotion === true,
          }
      const document = buildTaskDocument([step], environment.capabilities)
      const operators = [...job.opers.map(oper => `${oper.name}(${oper.skill}技能)`), ...job.groups.map(group => `${group.name}[${group.opers.map(oper => oper.name).join('/')}]`)]
      const ownership = item.ownership.status === 'ok' ? 'Box 显示干员齐全'
        : item.ownership.status === 'missing' ? `⚠ 缺少：${[...item.ownership.missing, ...item.ownership.weak].join('、')}；自动编队可能失败`
          : item.ownership.reason
      const purpose = args.purpose || `抄作业 ${stageCode || job.stageName}`
      const planSummary = [
        `${purpose}｜maa://${item.id}「${job.title || job.stageName}」作者 ${item.uploader || '未知'}`,
        `所需干员：${operators.join('、') || '未列出'}`,
        ownership,
        step.type === 'Copilot' && !step.stageName ? '将在游戏当前显示的关卡上执行，请先进入该关卡的开始行动界面' : '',
        step.useSanityPotion ? '允许使用理智药' : '',
      ].filter(Boolean).join('｜')
      const planJson = `${JSON.stringify(document, null, 2)}\n`
      const confirmation = await preparePendingPlan(exec.agent, { purpose, document, planJson, planSummary, generatedFiles: [{ marker, content: item.content }], panelMemory: false })
      exec.concludeTurn()
      return agentResult({ status: 'pending_confirmation', summary: planSummary, ...confirmation, data: { id: item.id, job, ownership: item.ownership } })
    },
    presentCall: args => ({ card: 'terminal', title: args.action === 'search' ? `搜索作业：${args.stage ?? ''}` : `准备作业：${args.copilotId ?? ''}` }),
  })

  ctx.tools.register({
    name: 'maa_doctor',
    description: 'Read-only environment health check for the local MAA setup: resolves maa-cli/Core versions and directories, proves the cache and config directories accept atomic temp-file renames (the EFS-encryption failure mode), verifies the MaaResource hot-update checkout, and checks the ADB binary, ADB port, and MuMu manager from the saved profile. Never starts the emulator, never connects to the game, and never modifies the game. Run it before a first game action or whenever a maa-cli command fails.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: DOCTOR_RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: formatReport(value) }] },
    async execute(_args, exec) { return await runDoctor({ runMaa, signal: exec.signal }) },
    presentCall: () => ({ card: 'terminal', title: 'MAA 环境体检' }),
  })

  ctx.tools.register({
    name: 'maa_runtime',
    description: 'Inspect or bootstrap the plugin-private MAA runtime, so the plugin works on a machine that never installed MAA. Actions: status (is maa-cli/MaaCore/resources ready, and where), install (download maa-cli from its GitHub release, then run `maa-cli install --batch` so maa-cli fetches the matching MaaCore build and resources into the runtime directory; roughly 250-450 MB and several minutes on a slow link), update (refresh MaaCore and resources). Everything lives under ~/.dsh/maa-cli/runtime (override with DSH_MAA_CLI_RUNTIME_DIR) and is isolated from any global MAA installation through MAA_DATA_DIR/MAA_STATE_DIR/MAA_CACHE_DIR/MAA_CONFIG_DIR. Never operates the game.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'update'] },
        force: { type: 'boolean', description: 'install: reinstall even when the runtime already looks complete.' },
        keepCaches: { type: 'boolean', description: 'install: keep the downloaded MaaCore archive (a few hundred MB) instead of deleting it after a successful install.' },
      },
    },
    output: { schema: RUNTIME_RESULT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      if (args.action === 'status') {
        const status = await inspectRuntime()
        return { action: 'status', installed: status.installed, summary: formatRuntimeReport(status), steps: [] }
      }
      if (args.action === 'update') {
        if (activeExecutions.size > 0) throw new Error('当前有 MAA 任务正在执行，暂不更新；任务结束后再试。')
        const updated = await updateRuntime({ run: runMaa, signal: exec.signal })
        const checkedAt = new Date().toISOString()
        if (updated.result.exitCode !== 0) {
          const detail = updated.result.stderr || updated.result.stdout || `exit ${updated.result.exitCode}`
          await updateManifest(updated.layout, { lastAutoUpdateCheckAt: checkedAt, lastAutoUpdateError: detail })
          throw new Error(`MAA 更新失败，原运行时继续保留：${detail}`)
        }
        await updateManifest(updated.layout, { lastAutoUpdateCheckAt: checkedAt, lastAutoUpdateSuccessAt: checkedAt, lastAutoUpdateError: '' })
        const status = await inspectRuntime()
        return {
          action: 'update', installed: status.installed, summary: formatRuntimeReport(status),
          steps: [{ id: 'update', detail: `maa-cli update 退出码 ${updated.result.exitCode}` }],
        }
      }
      const steps = []
      await bootstrapRuntime({
        run: runMaa,
        signal: exec.signal,
        force: args.force === true,
        keepCaches: args.keepCaches === true,
        onStep: (id, detail) => steps.push({ id, detail }),
      })
      const status = await inspectRuntime()
      return { action: 'install', installed: status.installed, summary: formatRuntimeReport(status), steps }
    },
    presentCall: args => ({ card: 'terminal', title: `MAA 运行时 ${args.action}` }),
  })
}
