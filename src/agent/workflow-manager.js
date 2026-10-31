import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'

const VERSION = 1
const MAX_PRESETS = 30
const MAX_EXECUTIONS = 20
let mutation = Promise.resolve()

export function workflowFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'workflows.json')
}

export async function readWorkflowState(options = {}) {
  try {
    const parsed = JSON.parse(await readFile(workflowFilePath(options.env ?? process.env), 'utf8'))
    if (parsed?.version !== VERSION || !Array.isArray(parsed.presets) || !Array.isArray(parsed.executions)) return emptyState()
    return { version: VERSION, presets: parsed.presets, executions: parsed.executions }
  } catch { return emptyState() }
}

export async function saveWorkflowPreset(input, options = {}) {
  const env = options.env ?? process.env
  return await mutate(env, state => {
    const now = options.now ?? Date.now()
    const id = input.id ? requiredId(input.id, 'workflow id') : `WF-${randomBytes(4).toString('hex').toUpperCase()}`
    const existing = state.presets.find(item => item.id === id)
    const preset = {
      id,
      name: requiredText(input.name, '工作流名称', 80),
      description: String(input.description ?? '').slice(0, 500),
      steps: normalizeSteps(input.steps),
      constraints: normalizeConstraints(input.constraints),
      capabilitySignature: String(input.capabilitySignature ?? ''),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    state.presets = [preset, ...state.presets.filter(item => item.id !== id)].slice(0, MAX_PRESETS)
    return preset
  })
}

export async function listWorkflowPresets(options = {}) {
  return (await readWorkflowState(options)).presets
}

export async function getWorkflowPreset(id, options = {}) {
  return (await readWorkflowState(options)).presets.find(item => item.id === id) ?? null
}

export async function deleteWorkflowPreset(id, options = {}) {
  const env = options.env ?? process.env
  return await mutate(env, state => {
    const existing = state.presets.find(item => item.id === id) ?? null
    state.presets = state.presets.filter(item => item.id !== id)
    return existing
  })
}

export async function createWorkflowExecution(input, options = {}) {
  const env = options.env ?? process.env
  return await mutate(env, state => {
    const now = options.now ?? Date.now()
    const execution = {
      id: `WFR-${randomBytes(4).toString('hex').toUpperCase()}`,
      presetId: String(input.presetId ?? ''),
      goalId: String(input.goalId ?? ''),
      name: requiredText(input.name, '工作流名称', 100),
      status: 'pending_confirmation',
      cursor: 0,
      constraints: normalizeConstraints(input.constraints),
      capabilitySignature: String(input.capabilitySignature ?? ''),
      steps: normalizeSteps(input.steps).map((step, index) => ({ ...step, index, status: 'pending', attempts: 0, runId: '', feedback: '', startedAt: null, finishedAt: null })),
      createdAt: now,
      updatedAt: now,
      needsUser: '',
    }
    state.executions = [execution, ...state.executions].slice(0, MAX_EXECUTIONS)
    return execution
  })
}

export async function getWorkflowExecution(id, options = {}) {
  return (await readWorkflowState(options)).executions.find(item => item.id === id) ?? null
}

export async function updateWorkflowExecution(id, updater, options = {}) {
  const env = options.env ?? process.env
  return await mutate(env, async state => {
    const index = state.executions.findIndex(item => item.id === id)
    if (index < 0) return null
    const current = structuredClone(state.executions[index])
    const next = await updater(current)
    if (!next || next.id !== id) throw new Error('工作流执行更新不能替换 ID。')
    next.updatedAt = options.now ?? Date.now()
    state.executions[index] = next
    return next
  })
}

export async function auditInterruptedWorkflows(options = {}) {
  const env = options.env ?? process.env
  return await mutate(env, state => {
    const changed = []
    for (const execution of state.executions) {
      if (!['running', 'recovering'].includes(execution.status)) continue
      execution.status = 'needs_review'
      execution.needsUser = 'DSH 在工作流执行期间退出。当前步骤是否完成无法可靠确认；已阻止自动续跑，请查看 MAA 日志和游戏状态后决定。'
      const step = execution.steps.find(item => item.status === 'running')
      if (step) {
        step.status = 'uncertain'
        step.feedback = 'DSH 重启前该步骤仍在运行，完成状态未知。'
        step.finishedAt = options.now ?? Date.now()
      }
      execution.updatedAt = options.now ?? Date.now()
      changed.push(execution.id)
    }
    return changed
  })
}

export function workflowDocument(execution) {
  return { tasks: execution.steps.filter(step => step.kind === 'maa').map(step => step.maa) }
}

export function normalizeWorkflowSteps(steps) {
  return normalizeSteps(steps)
}

async function mutate(env, updater) {
  const operation = mutation.then(async () => {
    const state = await readWorkflowState({ env })
    const result = await updater(state)
    await writeState(state, env)
    return result
  })
  mutation = operation.catch(() => {})
  return operation
}

async function writeState(state, env) {
  const file = workflowFilePath(env)
  await mkdir(path.dirname(file), { recursive: true })
  const payload = `${JSON.stringify(state, null, 2)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  try { await writeFile(temporary, payload, 'utf8'); await rename(temporary, file) }
  catch { await writeFile(file, payload, 'utf8'); await rm(temporary, { force: true }).catch(() => {}) }
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 30) throw new Error('工作流步骤必须有 1–30 项。')
  return steps.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`工作流步骤 ${index + 1} 无效。`)
    const kind = raw.kind ?? (raw.maa ? 'maa' : 'decision')
    const base = { id: String(raw.id ?? `step-${index + 1}`), kind, title: requiredText(raw.title ?? `步骤 ${index + 1}`, '步骤标题', 100) }
    if (kind === 'decision') return { ...base, prompt: requiredText(raw.prompt, '人工决策说明', 500) }
    if (kind !== 'maa' || !raw.maa || typeof raw.maa !== 'object' || typeof raw.maa.type !== 'string') throw new Error(`工作流步骤 ${index + 1} 缺少 MAA 任务。`)
    return { ...base, maa: structuredClone(raw.maa), completion: String(raw.completion ?? 'maa_verified') }
  })
}

function normalizeConstraints(input = {}) {
  const value = input && typeof input === 'object' ? input : {}
  return {
    allowStone: value.allowStone === true,
    maxMedicine: integer(value.maxMedicine ?? 0, 0, 999, 'maxMedicine'),
    maxExpiringMedicine: integer(value.maxExpiringMedicine ?? 0, 0, 999, 'maxExpiringMedicine'),
    maxSanity: value.maxSanity === undefined || value.maxSanity === null ? null : integer(value.maxSanity, 0, 100000, 'maxSanity'),
  }
}

function requiredText(value, label, max) {
  const text = String(value ?? '').trim()
  if (text.length < 1 || text.length > max) throw new Error(`${label} 长度必须是 1–${max}。`)
  return text
}

function requiredId(value, label) {
  const text = String(value ?? '')
  if (!/^[A-Za-z0-9_-]{3,64}$/u.test(text)) throw new Error(`${label} 格式无效。`)
  return text
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min}–${max} 的整数。`)
  return value
}

function emptyState() { return { version: VERSION, presets: [], executions: [] } }
