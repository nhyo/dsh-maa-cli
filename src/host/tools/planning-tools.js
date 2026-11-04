// Goal, workflow, training-advice and plan-preparation tools.
import { estimateTraining, goalPlanningContext, prepareGoalConfirmation, TRAINING_TARGET_PROPERTIES, workflowSummary } from '../goal-workflow.js'
import { AGENT_RESULT_SCHEMA, agentResult, NOTE_PREPARE_RESULT_SCHEMA, PREPARE_RESULT_SCHEMA, renderAgentResult, renderNoteResult, renderResult, STEP_PROPERTIES, STRATEGY_PREPARE_RESULT_SCHEMA, TRAINING_ADVICE_RESULT_SCHEMA } from '../tool-schemas.js'
import { loadPlanningData, readPlanningData, weeklyStageSchedule } from '../../agent/planning-data.js'
import { getGoal, listGoals, planGoal, updateGoal } from '../../agent/goal-manager.js'
import { createWorkflowExecution, deleteWorkflowPreset, getWorkflowExecution, getWorkflowPreset, listWorkflowPresets, saveWorkflowPreset, updateWorkflowExecution, workflowDocument } from '../../agent/workflow-manager.js'
import { activeWorkflows } from '../execution-state.js'
import { assertNoActiveRun } from '../run-control.js'
import { peekPendingPlan, preparePendingPlan } from '../../commands/confirmation.js'
import { documentWithNoteStrategy, memoryFallback, memorySummary, panelContext, readMaaStages, resolveStepDrops, roguelikeThemeOf, strategyEnvironment, WEEKDAY_LABELS, weeklyStageWarnings } from '../plan-environment.js'
import { buildTaskDocument, summarizePlan } from '../../commands/planner.js'
import { buildTrainingAdvice, fetchCommunityRanking, formatTrainingAdvice, loadOperatorMetadata } from '../../operators/training-advice.js'
import { readOperatorBox } from '../../operators/operator-box.js'
import { requireMaaCli } from '../../runtime/maa-cli.js'
import { queryArguments, runMaa } from '../../runtime/runner.js'
import { applyStrategyMemory, rememberPlanStrategies } from '../../strategy/memory.js'
import { compileStrategyRequest, GENERATED_COPILOT_MARKER, previewStrategy, previewStrategyDetails } from '../../strategy/compiler.js'
import { noteModelPrompt, parseStrategyNote } from '../../strategy/note.js'

export function registerPlanningTools(ctx) {
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
}
