// Result schemas and transcript renderers shared by the model tools.

export const BASE_RESULT_PROPERTIES = {
  command: { type: 'string' }, exitCode: { type: 'integer' }, terminationSignal: { type: 'string' },
  stdout: { type: 'string' }, stderr: { type: 'string' },
}

export const BASE_REQUIRED = Object.keys(BASE_RESULT_PROPERTIES)

export const MEMORY_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reused', 'stored', 'rejected', 'categories'],
  properties: {
    reused: { type: 'integer' }, stored: { type: 'integer' }, rejected: { type: 'integer' },
    categories: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
  },
}

export const RESULT_SCHEMA = { type: 'object', additionalProperties: false, required: BASE_REQUIRED, properties: BASE_RESULT_PROPERTIES }

export const PLAN_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [...BASE_REQUIRED, 'planFile', 'planJson', 'planSummary'],
  properties: { ...BASE_RESULT_PROPERTIES, planFile: { type: 'string' }, planJson: { type: 'string' }, planSummary: { type: 'string' } },
}

export const PREPARE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['purpose', 'planJson', 'planSummary', 'confirmationCode', 'confirmationPhrase', 'expiresAt', 'memory'],
  properties: {
    purpose: { type: 'string' }, planJson: { type: 'string' }, planSummary: { type: 'string' },
    confirmationCode: { type: 'string' }, confirmationPhrase: { type: 'string' }, expiresAt: { type: 'string' },
    memory: MEMORY_RESULT_SCHEMA,
  },
}

export const STRATEGY_PREPARE_RESULT_SCHEMA = {
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

export const NOTE_PREPARE_RESULT_SCHEMA = {
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

export const DOCTOR_RESULT_SCHEMA = {
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

export const RUNTIME_RESULT_SCHEMA = {
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

export const OPERATOR_PROPERTIES = {
  id: { type: 'string' }, name: { type: 'string' }, rarity: { type: 'integer' },
  elite: { type: 'integer' }, level: { type: 'integer' }, potential: { type: 'integer' },
}

export const OPERATOR_BOX_RESULT_SCHEMA = {
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

export const TRAINING_ADVICE_RESULT_SCHEMA = {
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

export const AGENT_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'goalId', 'workflowId', 'confirmationCode', 'confirmationPhrase', 'expiresAt', 'data'],
  properties: {
    status: { type: 'string' }, summary: { type: 'string' }, goalId: { type: 'string' }, workflowId: { type: 'string' },
    confirmationCode: { type: 'string' }, confirmationPhrase: { type: 'string' }, expiresAt: { type: 'string' }, data: { type: 'string' },
  },
}

export const STEP_PROPERTIES = {
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

export function renderResult(_args, value) {
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

export function renderNoteResult(_args, value) {
  if (value.status === 'needs_model') {
    return [{ type: 'text', text: [value.modelPrompt, '', `仍未解析：${(value.unresolved ?? []).join('、')}`].join('\n') }]
  }
  return renderResult(_args, value)
}

export function renderAgentResult(_args, value) {
  const lines = [value.summary]
  if (value.confirmationPhrase) lines.push('', '尚未操作游戏。请在确认面板核对目标、预算和步骤后确认，或输入：', `/maa confirm ${value.confirmationCode}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function agentResult(input = {}) {
  return {
    status: String(input.status ?? 'ok'), summary: String(input.summary ?? ''),
    goalId: String(input.goalId ?? ''), workflowId: String(input.workflowId ?? ''),
    confirmationCode: String(input.confirmationCode ?? ''), confirmationPhrase: String(input.confirmationPhrase ?? ''),
    expiresAt: String(input.expiresAt ?? ''), data: typeof input.data === 'string' ? input.data : JSON.stringify(input.data ?? null),
  }
}
