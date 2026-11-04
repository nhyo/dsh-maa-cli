// Custom base schedule and copilot-site tools.
import { AGENT_RESULT_SCHEMA, agentResult, renderAgentResult } from '../tool-schemas.js'
import { compileInfrastPlan, deleteInfrastPlan, describeInfrastPlan, listSavedInfrastPlans, ownershipWarnings, saveInfrastPlan } from '../../strategy/infrast-plan.js'
import { assertNoActiveRun } from '../run-control.js'
import { strategyEnvironment } from '../plan-environment.js'
import { readOperatorBox } from '../../operators/operator-box.js'
import { generatedFileMarker, loadOperatorNames } from '../../strategy/compiler.js'
import { buildTaskDocument } from '../../commands/planner.js'
import { preparePendingPlan } from '../../commands/confirmation.js'
import { formatCopilotCandidate, getCopilot, rankCopilots, searchCopilots } from '../../strategy/copilot-site.js'
import { COPILOT_MAX_SWITCHES, pickCopilotFallbacks } from '../execution.js'

export function registerFeatureTools(ctx) {
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
        autoSwitch: { type: 'boolean', description: 'prepare: when the job fails, automatically try up to 3 other same-stage jobs the Box can field (default true; the user gets a desktop notification on every switch).' },
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
      // Backups only make sense when MAA navigates to the stage itself: after
      // a lost battle the game is no longer on the stage's start screen.
      let fallbacks = []
      let fallbackNote = ''
      if (step.type === 'Copilot' && step.stageName && args.autoSwitch !== false) {
        try {
          const ranked = rankCopilots(await searchCopilots({ stage: stageCode, limit: 20 }, { signal: exec.signal }), box)
          fallbacks = pickCopilotFallbacks(ranked, item)
          fallbackNote = fallbacks.length
            ? `失败时自动换作业（最多 ${COPILOT_MAX_SWITCHES} 份，换时弹出通知）：${fallbacks.map(fallback => `maa://${fallback.id}`).join('、')}`
            : '作业站没有其他干员齐全的同关作业，失败时不会自动换作业'
        } catch (error) {
          fallbackNote = `备用作业查询失败，失败时不会自动换作业：${error instanceof Error ? error.message : String(error)}`
        }
      }
      const summaryWithFallback = [planSummary, fallbackNote].filter(Boolean).join('｜')
      const planJson = `${JSON.stringify(document, null, 2)}\n`
      const confirmation = await preparePendingPlan(exec.agent, {
        purpose, document, planJson, planSummary: summaryWithFallback, generatedFiles: [{ marker, content: item.content }], panelMemory: false,
        copilotCurrent: { id: item.id, title: job.title || job.stageName },
        copilotFallbacks: fallbacks.map(fallback => ({ id: fallback.id, title: fallback.job.title || fallback.job.stageName, content: fallback.content })),
      })
      exec.concludeTurn()
      return agentResult({ status: 'pending_confirmation', summary: summaryWithFallback, ...confirmation, data: { id: item.id, job, ownership: item.ownership, fallbacks: fallbacks.map(fallback => fallback.id) } })
    },
    presentCall: args => ({ card: 'terminal', title: args.action === 'search' ? `搜索作业：${args.stage ?? ''}` : `准备作业：${args.copilotId ?? ''}` }),
  })
}
