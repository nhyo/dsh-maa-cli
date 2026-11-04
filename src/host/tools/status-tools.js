// Read-only query and runtime-instruction tools.
import { AGENT_RESULT_SCHEMA, agentResult, OPERATOR_BOX_RESULT_SCHEMA, renderAgentResult, renderResult, RESULT_SCHEMA } from '../tool-schemas.js'
import { requireMaaCli } from '../../runtime/maa-cli.js'
import { queryArguments, runMaa } from '../../runtime/runner.js'
import { formatRuntimeInstructionResult } from '../formatting.js'
import { executeRuntimeInstruction } from '../run-control.js'
import { queryOperatorBox, readOperatorBox } from '../../operators/operator-box.js'
import { loadItemIndex, queryDepot, readDepot } from '../../operators/depot.js'
import { strategyEnvironment } from '../plan-environment.js'

export function registerStatusTools(ctx) {
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
}
