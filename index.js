import { actionArguments, isRuntimePath, queryArguments, resolveMaaCliPath, runMaa } from './runner.js'
import { buildTaskDocument, GENERATED_TASK_NAME, summarizePlan, writeGeneratedTask, applyRoguelikeOverrides } from './planner.js'
import { consumePlanFromHumanGesture, peekPendingPlan, preparePendingPlan } from './confirmation.js'
import { parseLocalMaaCommand } from './local-command.js'
import { formatReport, runDoctor } from './doctor.js'
import { prepareRuntimeDirectories } from './preflight.js'
import { checkEmulator, emulatorErrorMessage } from './emulator.js'
import { bootstrapRuntime, exists, formatRuntimeReport, inspectRuntime, maybeAutoUpdateRuntime, updateManifest, updateRuntime } from './runtime.js'
import {
  formatOperatorBoxScanResult,
  parseCompletedOperatorBox,
  queryOperatorBox,
  readOperatorBox,
  saveOperatorBox,
  stripOperBoxCallbacks,
} from './operator-box.js'
import { buildTrainingAdvice, fetchCommunityRanking, formatTrainingAdvice, loadOperatorMetadata } from './training-advice.js'

export const name = 'maa-cli-tools'
export const inject = ['tools', 'commands']

const BASE_RESULT_PROPERTIES = {
  command: { type: 'string' }, exitCode: { type: 'integer' }, terminationSignal: { type: 'string' },
  stdout: { type: 'string' }, stderr: { type: 'string' },
}
const BASE_REQUIRED = Object.keys(BASE_RESULT_PROPERTIES)
const RESULT_SCHEMA = { type: 'object', additionalProperties: false, required: BASE_REQUIRED, properties: BASE_RESULT_PROPERTIES }
const PLAN_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [...BASE_REQUIRED, 'planFile', 'planJson', 'planSummary'],
  properties: { ...BASE_RESULT_PROPERTIES, planFile: { type: 'string' }, planJson: { type: 'string' }, planSummary: { type: 'string' } },
}
const PREPARE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['purpose', 'planJson', 'planSummary', 'confirmationCode', 'confirmationPhrase', 'expiresAt'],
  properties: {
    purpose: { type: 'string' }, planJson: { type: 'string' }, planSummary: { type: 'string' },
    confirmationCode: { type: 'string' }, confirmationPhrase: { type: 'string' }, expiresAt: { type: 'string' },
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

const STEP_PROPERTIES = {
  type: { type: 'string', enum: ['StartUp', 'Fight', 'Infrast', 'Recruit', 'Mall', 'Award', 'Roguelike', 'ReclamationAlgorithm', 'Depot', 'OperBox', 'Custom', 'CloseDown'] },
  clientType: { type: 'string', enum: ['Official', 'Bilibili', 'Txwy', 'YoStarEN', 'YoStarJP', 'YoStarKR'], description: 'Optional game client for the whole plan. It may appear on any step; all provided values must match.' },
  stage: { type: 'string' }, times: { type: 'integer' }, medicine: { type: 'integer' }, expiringMedicine: { type: 'integer' }, stone: { type: 'integer' },
  mode: { type: 'integer' }, facilities: { type: 'array', items: { type: 'string', enum: ['Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Dorm'] } },
  drones: { type: 'string', enum: ['_NotUse', 'Money', 'SyntheticJade', 'CombatRecord', 'PureGold', 'OriginStone', 'Chip'] }, threshold: { type: 'number' }, replenish: { type: 'boolean' }, dormNotStationed: { type: 'boolean' }, dormTrust: { type: 'boolean' },
  refresh: { type: 'boolean' }, select: { type: 'array', items: { type: 'integer' } }, confirm: { type: 'array', items: { type: 'integer' } }, setTime: { type: 'boolean' }, expedite: { type: 'boolean' }, permitReserve: { type: 'integer' }, firstTags: { type: 'array', items: { type: 'string' } }, extraTagsMode: { type: 'integer' },
  shopping: { type: 'boolean' }, buyFirst: { type: 'array', items: { type: 'string' } }, blacklist: { type: 'array', items: { type: 'string' } }, forceShoppingIfCreditFull: { type: 'boolean' }, onlyBuyDiscount: { type: 'boolean' }, reserveMaxCredit: { type: 'boolean' }, visitFriends: { type: 'boolean' }, creditFight: { type: 'boolean' },
  dailyWeekly: { type: 'boolean' }, mail: { type: 'boolean' }, freePull: { type: 'boolean' }, orundum: { type: 'boolean' }, mining: { type: 'boolean' }, specialAccess: { type: 'boolean' }, signInEvent: { type: 'boolean' },
  theme: { type: 'string', enum: ['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden'] }, squad: { type: 'string' }, coreChar: { type: 'string' }, roles: { type: 'string' }, startsCount: { type: 'integer' }, difficulty: { type: 'integer' }, useSupport: { type: 'boolean' }, useNonFriendSupport: { type: 'boolean' }, stopAtFinalBoss: { type: 'boolean' },
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

function formatCommandResult(result) {
  const lines = [`MAA 已结束（退出码 ${result.exitCode}）。`, `计划：${result.planSummary}`]
  if (result.operatorBox) lines.push('', formatOperatorBoxScanResult(result.operatorBox))
  if (result.operatorBoxError) lines.push('', `干员 Box 结果读取失败：${result.operatorBoxError}`)
  if (result.maintenanceWarning) lines.push('', result.maintenanceWarning)
  if (result.stdout) lines.push('', result.stdout)
  if (result.stderr) lines.push('', result.stderr)
  return lines.join('\n')
}

const activeExecutions = new Map()

function agentKey(agent) {
  if (!agent || agent.id === undefined) throw new Error('当前命令没有可用的 DSH 会话。')
  return String(agent.id)
}

function stopActiveExecution(agent) {
  const key = agentKey(agent)
  const active = activeExecutions.get(key)
  if (!active) return false
  active.controller.abort()
  return true
}

async function executeDocument(agent, signal, document, planSummary, options = {}) {
  const key = agentKey(agent)
  if (activeExecutions.has(key)) throw new Error('当前 DSH 会话已有一个 MAA 任务正在执行。')
  const controller = new AbortController()
  const executionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const active = { controller, planSummary }
  activeExecutions.set(key, active)
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
    const written = await writeGeneratedTask(document, { configDir })
    const hasOperatorBox = document.tasks.some(task => task.type === 'OperBox')
    const result = await runMaa(actionArguments('run_task', GENERATED_TASK_NAME, true), {
      signal: executionSignal,
      timeoutMs: 30 * 60_000,
      outputLimit: hasOperatorBox ? 16 * 1024 * 1024 : undefined,
      envPatch: hasOperatorBox ? { MAA_LOG: 'info', MAA_LOG_PREFIX: 'Never' } : undefined,
    })
    if (!hasOperatorBox) return { ...result, planFile: written.path, planJson: written.json, planSummary, maintenanceWarning: maintenance.warning }

    const cleanStderr = stripOperBoxCallbacks(result.stderr)
    if (result.exitCode !== 0) {
      return { ...result, stderr: cleanStderr, planFile: written.path, planJson: written.json, planSummary, maintenanceWarning: maintenance.warning }
    }
    try {
      const operatorBox = parseCompletedOperatorBox(`${result.stdout}\n${result.stderr}`)
      await saveOperatorBox(operatorBox)
      return { ...result, stderr: cleanStderr, planFile: written.path, planJson: written.json, planSummary, operatorBox, maintenanceWarning: maintenance.warning }
    } catch (error) {
      return {
        ...result, stderr: cleanStderr, planFile: written.path, planJson: written.json, planSummary,
        operatorBoxError: error instanceof Error ? error.message : String(error), maintenanceWarning: maintenance.warning,
      }
    }
  } finally {
    if (activeExecutions.get(key) === active) activeExecutions.delete(key)
  }
}

export function apply(ctx) {
  ctx.commands.register({
    name: 'maa',
    definitionId: 'dsh-maa-cli/maa',
    description: '直接运行常用 MAA 操作，不调用模型',
    input: { hint: '<help | setup | fight 1-7 2 | startup | infrast | award | closedown | stop | confirm MAA-XXXXXX theme=... startsCount=...>' },
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
        if (parsed.kind === 'stop') {
          return stopActiveExecution(agent)
            ? { kind: 'success', text: '已停止当前 DSH 会话启动的 MAA 任务。游戏和模拟器没有被关闭。' }
            : { kind: 'error', text: '当前 DSH 会话没有正在执行的 MAA 任务。' }
        }
        if (parsed.kind === 'confirm') {
          // The slash command or the button that invokes it is the explicit
          // human authorization; the pending plan remains scoped and one-shot.
          await ensureMaaCli(signal)
          const emulator = await checkEmulator({ runMaa, signal })
          if (!emulator.ok) throw new Error(emulatorErrorMessage(emulator))
          // Validate confirmation-time parameter overrides against the pending
          // document before consuming it, so a bad value never burns the code.
          const peeked = Object.keys(parsed.overrides ?? {}).length > 0 ? await peekPendingPlan(agent) : null
          const patched = peeked ? applyRoguelikeOverrides(peeked.document, parsed.overrides) : null
          const planSummary = patched
            ? `${peeked.planSummary}｜确认时调整：${patched.applied.join('、')}`
            : undefined
          const pending = await consumePlanFromHumanGesture(agent, parsed.confirmationCode)
          const result = await executeDocument(agent, signal, patched ? patched.document : pending.document, planSummary ?? pending.planSummary, { emulatorChecked: true })
          return { kind: result.exitCode === 0 && !result.operatorBoxError ? 'success' : 'error', text: formatCommandResult(result) }
        }
        const document = buildTaskDocument(parsed.steps)
        const summary = summarizePlan(parsed.steps)
        const result = await executeDocument(agent, signal, document, summary)
        return { kind: result.exitCode === 0 && !result.operatorBoxError ? 'success' : 'error', text: formatCommandResult(result) }
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
    description: `Prepare, validate, and preview an ordered MaaCore plan from the user's natural-language Arknights request, but DO NOT operate the game. Always use this tool first for a game action. Decompose the request into 1-20 steps. Supported steps: StartUp, Fight, Infrast, Recruit, Mall, Award, Roguelike, ReclamationAlgorithm, Depot, OperBox, Custom existing MaaCore task names, CloseDown. Fight requires finite times (1-100); do not provide a series field because the plugin automatically uses one in-game consecutive battle for totals up to 10 and automatic grouping above 10. Roguelike requires startsCount (1-20). Never infer permission to spend resources: medicine, expiringMedicine, stone, Recruit expedite, Mall shopping, reward mail/freePull/event options, drones, or reclamation crafting remain disabled/default unless explicitly requested. If ambiguous, ask before preparing. This tool ends the current turn and returns a one-time local confirmation button; when the plan contains a Roguelike step the confirmation UI also shows MAA-style roguelike settings (theme, startsCount, difficulty, squad, coreChar, support, stopAtFinalBoss) that the user may adjust there without re-preparing the plan. Clicking confirm executes through the non-model command plane and does not create another model call.`,
    parameters: {
      type: 'object', additionalProperties: false, required: ['purpose', 'steps'],
      properties: {
        purpose: { type: 'string', description: 'Short Chinese summary of the user request.' },
        steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['type'], properties: STEP_PROPERTIES } },
      },
    },
    output: { schema: PREPARE_RESULT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const document = buildTaskDocument(args.steps)
      const planSummary = summarizePlan(args.steps)
      const planJson = `${JSON.stringify(document, null, 2)}\n`
      const confirmation = await preparePendingPlan(exec.agent, { purpose: args.purpose, document, planJson, planSummary })
      exec.concludeTurn()
      return { purpose: args.purpose, planJson, planSummary, confirmationCode: confirmation.confirmationCode, confirmationPhrase: confirmation.confirmationPhrase, expiresAt: confirmation.expiresAt }
    },
    presentCall: args => ({ card: 'terminal', title: `准备MAA计划：${args.purpose}` }),
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
