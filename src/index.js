import { actionArguments, isRuntimePath, queryArguments, resolveMaaCliPath, runMaa, startMaa } from './runtime/runner.js'
import path from 'node:path'
import { buildTaskDocument, GENERATED_TASK_NAME, summarizePlan, writeGeneratedTask } from './commands/planner.js'
import { consumePlanFromHumanGesture, peekPendingPlan, preparePendingPlan, updatePendingPlan } from './commands/confirmation.js'
import { parseLocalMaaCommand } from './commands/local-command.js'
import { activeRun, beginRun, describeRunState, finishRun, getRun, reapGeneratedTaskProcesses, stopRun } from './commands/run-state.js'
import { applyRuntimeInstruction, completeTriggeredInstructions, parseMaaCallbackLine, processMaaCallback, startLogTail } from './commands/runtime-instructions.js'
import { applyTaskPanelOverrides, taskPanelFromDocument } from './commands/task-panel.js'
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
import { buildTrainingAdvice, fetchCommunityRanking, formatTrainingAdvice, loadOperatorMetadata } from './operators/training-advice.js'
import {
  compileStrategyRequest,
  GENERATED_COPILOT_MARKER,
  materializeStrategy,
  previewStrategy,
  previewStrategyDetails,
} from './strategy/compiler.js'
import {
  applyStrategyMemory, deleteStrategyMemory, listStrategyMemory, parseMaaCompatibility,
  rememberPlanStrategies, setStrategyMemoryEnabled,
} from './strategy/memory.js'
import { noteModelPrompt, parseStrategyNote } from './strategy/note.js'

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
  const capabilities = await discoverMaaCapabilities({ resourceDir, compatibility })
  return { resourceDir, compatibility, capabilities }
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
  if (!tasks.some(task => task?.type === 'Roguelike')) return
  const capabilities = environment?.capabilities ?? (await strategyEnvironment()).capabilities
  await rememberPanelValues(taskPanelFromDocument(document, capabilities))
}

async function prepareNotePreview(agent, confirmationCode, rawNote, overrides, signal) {
  const note = decodeConfirmationNote(rawNote)
  const pending = await peekPendingPlan(agent)
  if (pending.confirmationCode !== confirmationCode) throw new Error('MAA 确认码与待确认计划不一致。')
  const environment = await strategyEnvironment(signal)
  const patch = Object.keys(overrides ?? {}).length ? applyTaskPanelOverrides(pending.document, overrides, environment.capabilities) : null
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
  stage: { type: 'string' }, times: { type: 'integer' }, medicine: { type: 'integer' }, expiringMedicine: { type: 'integer' }, stone: { type: 'integer' },
  mode: { type: 'integer' }, facilities: { type: 'array', items: { type: 'string', enum: ['Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Dorm'] } },
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
let activeStrategyExecution = false

function agentKey(agent) {
  if (!agent || agent.id === undefined) throw new Error('当前命令没有可用的 DSH 会话。')
  return String(agent.id)
}

async function executeRuntimeInstruction(request) {
  const running = await activeRun()
  if (!running) return { status: 'not_running', message: '当前没有正在执行的 MAA 任务。', run: null }
  const active = activeRuns.get(running.id)
  const result = await applyRuntimeInstruction(running.id, request, {
    monitorAvailable: Boolean(active),
    stop: instructionId => {
      if (!active) return
      active.triggerInstructionId = instructionId
      active.controller.abort()
    },
  })
  if (request.action === 'stop_now' && !active) {
    await stopRun(running.id)
    await completeTriggeredInstructions(running.id)
  }
  const latest = await getRun(running.id)
  return { ...result, run: latest }
}

function formatRuntimeInstructionResult(result) {
  if (result.status === 'ok' && result.run) return JSON.stringify({ running: result.run })
  return result.message || JSON.stringify(result)
}

// A running MAA task owns the emulator, the generated task file, and the user
// resource overlay. Until it ends no new plan may replace them, not even from
// another DSH session.
async function assertNoActiveRun() {
  const running = await activeRun()
  if (!running) return
  throw new Error(`MAA 任务正在执行中（${running.purpose || running.confirmationCode || running.id}，已运行 ${new Date(running.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} 起）。为避免抢屏幕和覆盖临时资源，完成前不接受新的计划或任务；可以等待，或在确认面板点击「停止任务」/ 输入 /maa stop。`)
}

async function executeDocument(agent, signal, document, planSummary, options = {}) {
  const key = agentKey(agent)
  if (activeExecutions.has(key)) throw new Error('当前 DSH 会话已有一个 MAA 任务正在执行。')
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
  const active = { controller, planSummary, runId: run.id, monitor: null, triggerInstructionId: '' }
  activeExecutions.set(key, active)
  activeRuns.set(run.id, active)
  let strategyExecution = null
  let strategyReserved = false
  let recorded = { status: 'failed', exitCode: null, summary: 'MAA 执行没有返回结果。' }
  let detached = false

  const release = async () => {
    // Never let bookkeeping failure hide the execution outcome.
    if (active.monitor) {
      await active.monitor.flush().catch(() => {})
      active.monitor.stop()
    }
    await finishRun(run.id, recorded).catch(() => {})
    await completeTriggeredInstructions(run.id).catch(() => {})
    try {
      if (strategyExecution) await strategyExecution.restore()
    } finally {
      if (strategyReserved) activeStrategyExecution = false
      if (activeExecutions.get(key) === active) activeExecutions.delete(key)
      if (activeRuns.get(run.id) === active) activeRuns.delete(run.id)
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
    const written = await writeGeneratedTask(executionDocument, { configDir })
    const hasOperatorBox = executionDocument.tasks.some(task => task.type === 'OperBox')
    const settle = async result => {
      const executionFeedback = classifyMaaExecution(result, strategyExecution !== null)
      recorded = {
        status: executionFeedback.status === 'failed' || result.exitCode !== 0 ? 'failed' : 'succeeded',
        exitCode: result.exitCode,
        summary: executionFeedback.headline,
      }
      if (!hasOperatorBox) return { ...result, planFile: written.path, planJson: written.json, planSummary, maintenanceWarning: maintenance.warning, executionFeedback }
      const cleanStderr = stripOperBoxCallbacks(result.stderr)
      if (result.exitCode !== 0) {
        return { ...result, stderr: cleanStderr, planFile: written.path, planJson: written.json, planSummary, maintenanceWarning: maintenance.warning, executionFeedback }
      }
      try {
        const operatorBox = parseCompletedOperatorBox(`${result.stdout}\n${result.stderr}`)
        await saveOperatorBox(operatorBox)
        return { ...result, stderr: cleanStderr, planFile: written.path, planJson: written.json, planSummary, operatorBox, maintenanceWarning: maintenance.warning, executionFeedback }
      } catch (error) {
        recorded = { status: 'failed', exitCode: result.exitCode, summary: '任务已执行，但无法解析干员 Box。' }
        return {
          ...result, stderr: cleanStderr, planFile: written.path, planJson: written.json, planSummary,
          operatorBoxError: error instanceof Error ? error.message : String(error), maintenanceWarning: maintenance.warning, executionFeedback,
        }
      }
    }
    const runOptions = {
      signal: executionSignal,
      timeoutMs: 30 * 60_000,
      outputLimit: hasOperatorBox ? 16 * 1024 * 1024 : undefined,
      envPatch: hasOperatorBox ? { MAA_LOG: 'info', MAA_LOG_PREFIX: 'Never' } : undefined,
    }
    const runArguments = actionArguments('run_task', GENERATED_TASK_NAME, true, strategyExecution?.userResource === true)
    if (!backgroundWanted) {
      const result = await runMaa(runArguments, runOptions)
      return await settle(result)
    }
    // Background mode: return as soon as MAA is running. A five-minute command
    // timeout used to abort healthy runs, so the child is owned by this process
    // instead of the command call; /maa stop aborts `controller` and kills it.
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
        await processMaaCallback(run.id, callback, {
          stop: instructionId => {
            active.triggerInstructionId = instructionId
            controller.abort()
          },
        })
      })
    }
    const handle = startMaa(runArguments, { ...runOptions, hardTimeoutMs: 6 * 60 * 60_000 })
    active.pid = handle.pid
    detached = true
    void handle.done
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
      pid: handle.pid,
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

function formatBackgroundResult(result) {
  return [
    `MAA 已开始执行（${result.runId}）。`,
    `计划：${result.planSummary}`,
    '任务在后台运行：确认面板会显示「执行中」和本地计时，需要中止时点击「停止任务」或输入 /maa stop；结束后点「查看执行记录」查看结果。',
    result.maintenanceWarning ?? '',
  ].filter(Boolean).join('\n')
}

export function apply(ctx) {
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
          return { kind: 'success', text: JSON.stringify(await describeRunState()) }
        }
        if (parsed.kind === 'runtime-instruction') {
          const result = await executeRuntimeInstruction(parsed.request)
          return { kind: result.status === 'not_running' ? 'error' : 'success', text: formatRuntimeInstructionResult(result) }
        }
        if (parsed.kind === 'stop') {
          const runtime = await executeRuntimeInstruction({ action: 'stop_now' })
          if (runtime.status !== 'not_running') {
            return { kind: 'success', text: formatRuntimeInstructionResult(runtime) }
          }
          // DSH may have restarted while maa-cli kept running. Finish the stray
          // record and stop only the process tree that runs dsh-generated.
          const snapshot = await describeRunState()
          const stale = snapshot.running ?? snapshot.interrupted
          if (stale) {
            await stopRun(stale.id)
            return { kind: 'success', text: `已结束残留的 MAA 执行记录（${stale.purpose || stale.id}，${stale.duration}），并清理了正在运行的 dsh-generated 进程。` }
          }
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
          return {
            kind: 'success',
            text: JSON.stringify({
              code: pending.confirmationCode,
              summary: pending.planSummary,
              theme: roguelikeThemeOf(pending.document),
              panel: await applyRememberedConfig(taskPanelFromDocument(pending.document, environment.capabilities)),
              capabilitySignature: environment.capabilities.signature,
              capabilitySource: environment.capabilities.source,
              capabilityWarning: environment.capabilities.warning ?? '',
              notePreview: publicNotePreview(pending.notePreview),
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
          // The slash command or the button that invokes it is the explicit
          // human authorization; the pending plan remains scoped and one-shot.
          await assertNoActiveRun()
          await ensureMaaCli(signal)
          const emulator = await checkEmulator({ runMaa, signal })
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
          const patched = hasOverrides && !note ? applyTaskPanelOverrides(confirmationDocument, overrides, confirmationEnvironment.capabilities) : null
          const adjustments = patched && patched.applied.length > 0 ? `｜确认时调整：${patched.applied.join('、')}` : ''
          const pending = await consumePlanFromHumanGesture(agent, parsed.confirmationCode)
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
          const result = await executeDocument(agent, signal, finalDocument, planSummary, { background: true, emulatorChecked: true, strategy: confirmationStrategy ?? pending.strategy, purpose, confirmationCode: pending.confirmationCode })
          if (result.background) return { kind: 'success', text: formatBackgroundResult(result) }
          const text = formatCommandResult(result)
          return { kind: result.executionFeedback?.status !== 'failed' && !result.operatorBoxError ? 'success' : 'error', text }
        }
        const environment = await strategyEnvironment(signal)
        let document = buildTaskDocument(parsed.steps, environment.capabilities)
        let summary = summarizePlan(parsed.steps, environment.capabilities)
        // Parameter adjustments are validated against the same whitelist the
        // confirmation panel uses, and a bad value aborts before anything is
        // written or executed.
        const overrides = parsed.roguelikeOverrides ?? {}
        if (Object.keys(overrides).length > 0) {
          const patched = applyTaskPanelOverrides(document, overrides, environment.capabilities)
          document = patched.document
          if (patched.applied.length > 0) summary = `${summary}｜参数：${patched.applied.join('、')}`
        }
        if (parsed.kind === 'plan') {
          // Every zero-model task only prepares: the client turns this notice
          // into its MAA-style parameter panel, and the button executes
          // `/maa confirm` on the local command plane. No model turn, no tokens.
          const pending = await preparePendingPlan(agent, { planSummary: summary, document })
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
    description: 'Control or inspect the MAA task that is already running. Use this for runtime requests such as stop now, stop after the current roguelike exploration, stop before a numbered boss floor, stop after N more explorations, cancel a pending stop, query progress, or request a recruitment preference. Common requests are handled locally; temporary runtime instructions are never written to long-term strategy memory. A recruitment preference may return unsupported instead of pretending that maa-cli applied it live.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['stop_now', 'stop_after_current', 'stop_after_runs', 'stop_before_boss', 'cancel_stop', 'status', 'prefer_recruit'] },
        count: { type: 'integer', minimum: 1, maximum: 99 },
        floor: { type: 'integer', minimum: 1, maximum: 99 },
        operator: { type: 'string', minLength: 1, maxLength: 20 },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, required: ['status'], properties: { status: { type: 'string' }, message: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: formatRuntimeInstructionResult(value) }],
    },
    async execute(args) { return await executeRuntimeInstruction(args) },
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
    description: `Prepare, validate, and preview an ordered MaaCore plan from the user's natural-language Arknights request, but DO NOT operate the game. Always use this tool first for a game action. Decompose the request into 1-20 steps. Supported steps: StartUp, Fight, Infrast, Recruit, Mall, Award, Roguelike, ReclamationAlgorithm, Depot, OperBox, Custom existing MaaCore task names, CloseDown. Fight requires finite times (1-100); do not provide a series field because the plugin automatically uses one in-game consecutive battle for totals up to 10 and automatic grouping above 10. Roguelike requires startsCount (1-99999; the confirmation panel starts at 9999). Never infer permission to spend resources: medicine, expiringMedicine, stone, Recruit expedite, Mall shopping, reward mail/freePull/event options, drones, or reclamation crafting remain disabled/default unless explicitly requested. If ambiguous, ask before preparing. This tool ends the current turn and returns a one-time local confirmation button; when the plan contains a Roguelike step the confirmation UI also shows MAA-style roguelike settings — theme, mode, difficulty, squad, role group, starting operator and MAA's advanced switches — pre-filled from MAA's recommended opening (marked 【推荐】 and freely editable), so the user may adjust there without re-preparing the plan; a 备注 field next to the validity hint is handed back to DSH as free-form guidance that DSH may act on but is not guaranteed to. Clicking confirm executes through the non-model command plane and does not create another model call.`,
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
      const document = buildTaskDocument(args.steps, environment.capabilities)
      let memory
      try {
        memory = await rememberPlanStrategies(args.steps, environment.compatibility, { capabilities: environment.capabilities })
      } catch (error) {
        memory = memoryFallback(error, args.steps.length)
      }
      const planSummary = `${summarizePlan(args.steps, environment.capabilities)}${memorySummary(memory)}`
      const planJson = `${JSON.stringify(document, null, 2)}\n`
      const confirmation = await preparePendingPlan(exec.agent, { purpose: args.purpose, document, planJson, planSummary })
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
      const confirmation = await preparePendingPlan(exec.agent, { purpose: args.purpose, document, planJson, planSummary, strategy })
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
      const confirmation = await preparePendingPlan(exec.agent, { purpose, document, planJson, planSummary, strategy: applied, notePreview })
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
