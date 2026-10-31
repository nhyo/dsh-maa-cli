import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createGoal, planGoal, updateGoal } from '../src/agent/goal-manager.js'
import { consumePlanFromHumanGesture, peekPendingPlan, preparePendingPlan } from '../src/commands/confirmation.js'

import {
  auditInterruptedWorkflows,
  createWorkflowExecution,
  deleteWorkflowPreset,
  getWorkflowExecution,
  getWorkflowPreset,
  listWorkflowPresets,
  saveWorkflowPreset,
  updateWorkflowExecution,
} from '../src/agent/workflow-manager.js'

async function temporaryEnv(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-workflow-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { DSH_MAA_CLI_STATE_DIR: dir }
}

const steps = [{ id: 'award', kind: 'maa', title: '领奖', maa: { type: 'Award', params: { award: true } } }]

test('workflow presets can be saved, edited, loaded, listed, and deleted', async t => {
  const env = await temporaryEnv(t)
  const saved = await saveWorkflowPreset({ name: '日常', steps, capabilitySignature: 'sig-a' }, { env, now: 1 })
  assert.equal((await listWorkflowPresets({ env }))[0].name, '日常')
  await saveWorkflowPreset({ id: saved.id, name: '安全日常', steps, capabilitySignature: 'sig-b' }, { env, now: 2 })
  assert.equal((await getWorkflowPreset(saved.id, { env })).name, '安全日常')
  assert.equal((await getWorkflowPreset(saved.id, { env })).createdAt, 1)
  assert.equal((await deleteWorkflowPreset(saved.id, { env })).id, saved.id)
  assert.equal(await getWorkflowPreset(saved.id, { env }), null)
})

test('restart audit makes an in-flight step uncertain instead of replaying it', async t => {
  const env = await temporaryEnv(t)
  const execution = await createWorkflowExecution({ name: '中断任务', steps }, { env, now: 10 })
  await updateWorkflowExecution(execution.id, current => {
    current.status = 'running'
    current.steps[0].status = 'running'
    return current
  }, { env, now: 20 })
  assert.deepEqual(await auditInterruptedWorkflows({ env, now: 30 }), [execution.id])
  const audited = await getWorkflowExecution(execution.id, { env })
  assert.equal(audited.status, 'needs_review')
  assert.equal(audited.steps[0].status, 'uncertain')
  assert.match(audited.needsUser, /阻止自动续跑/u)
})

test('goal plan persists through workflow creation and one-time confirmation', async t => {
  const env = await temporaryEnv(t)
  const plan = await planGoal({ kind: 'daily' })
  const goal = await createGoal({ kind: 'daily', title: '今日任务' }, plan, { env, now: 1 })
  const execution = await createWorkflowExecution({ goalId: goal.id, name: goal.title, steps: plan.steps, constraints: plan.constraints, capabilitySignature: 'sig' }, { env, now: 2 })
  await updateGoal(goal.id, { workflowExecutionId: execution.id }, { env, now: 3 })
  const agent = { id: 'goal-confirm', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] } }
  const confirmation = await preparePendingPlan(agent, { document: { tasks: execution.steps.map(step => step.maa) }, planSummary: '今日任务', goalId: goal.id, workflowExecutionId: execution.id }, { env, now: 4, code: 'MAA-GOAL01' })
  assert.equal((await peekPendingPlan(agent, { env })).workflowExecutionId, execution.id)
  const consumed = await consumePlanFromHumanGesture(agent, confirmation.confirmationCode, { env, now: 5 })
  assert.equal(consumed.goalId, goal.id)
  await assert.rejects(consumePlanFromHumanGesture(agent, confirmation.confirmationCode, { env, now: 6 }), /没有待确认/u)
})
