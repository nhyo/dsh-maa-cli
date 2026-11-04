// Goal planning and workflow execution entry points.
import { readMaaStages, strategyEnvironment } from './plan-environment.js'
import { readOperatorBox } from '../operators/operator-box.js'
import { loadItemIndex, readDepot } from '../operators/depot.js'
import { applyDropRates, applyJointPlan, loadPlanningData, planWithArkPlanner } from '../agent/planning-data.js'
import { agentResult } from './tool-schemas.js'
import { createGoal, getGoal, planGoal, trainingRequirements, updateGoal } from '../agent/goal-manager.js'
import { assertNoActiveRun } from './run-control.js'
import { buildTaskDocument } from '../commands/planner.js'
import { createWorkflowExecution, getWorkflowExecution, updateWorkflowExecution, workflowDocument } from '../agent/workflow-manager.js'
import { preparePendingPlan } from '../commands/confirmation.js'
import { activeWorkflows, agentKey } from './execution-state.js'
import { executeDocument } from './execution.js'

export async function goalPlanningContext(signal, server = 'CN', includePlanningData = true) {
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

export const TRAINING_TARGET_PROPERTIES = {
  operator: { type: 'string' },
  targetElite: { type: 'integer', minimum: 0, maximum: 2, description: 'Target elite phase. Omit together with targetLevel when only skills/modules are wanted.' },
  targetLevel: { type: 'integer', minimum: 1, maximum: 90 },
  skillLevel: { type: 'object', additionalProperties: false, properties: { current: { type: 'integer', minimum: 1, maximum: 7 }, target: { type: 'integer', minimum: 1, maximum: 7 } }, description: 'Common skill level 1-7. current must come from the user: the Box scan has no skill levels.' },
  masteries: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['skill', 'target'], properties: { skill: { type: 'integer', minimum: 1, maximum: 3 }, current: { type: 'integer', minimum: 0, maximum: 3 }, target: { type: 'integer', minimum: 1, maximum: 3 } } }, description: 'Specialization goals, e.g. skill 2 to M3. current (0 = none) must come from the user.' },
  modules: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['target'], properties: { type: { type: 'string', description: 'Module type letter such as X / Y / D, or its name.' }, current: { type: 'integer', minimum: 0, maximum: 3 }, target: { type: 'integer', minimum: 1, maximum: 3 } } }, description: 'Module goals. current (0 = locked) must come from the user.' },
}

// Read-only "do I have enough for …" answer built from the same calculation
// the goal planner uses.
export async function estimateTraining(args, signal) {
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

export async function prepareGoalConfirmation(args, exec) {
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

export function goalTitle(input) {
  if (input.kind === 'daily') return '完成今天的日常任务'
  if (input.kind === 'operator_training') return `培养${Array.isArray(input.operators) && input.operators.length ? input.operators.map(item => item.operator).join('、') : input.operator || '指定干员'}`
  if (input.kind === 'materials') return '规划并获取缺少的材料'
  return '自定义游戏目标'
}

export function workflowSummary(execution) {
  const completed = execution.steps.filter(step => step.status === 'completed').length
  return `${execution.name}：${completed}/${execution.steps.length} 步，状态 ${execution.status}${execution.needsUser ? `；${execution.needsUser}` : ''}`
}

export async function startWorkflowExecution(agent, executionId, goalId = '', confirmationCode = '') {
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
