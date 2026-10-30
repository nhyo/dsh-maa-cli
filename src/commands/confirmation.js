import { randomBytes } from 'node:crypto'
import { prunePendingPlans, readState, savePendingPlan, stateFilePath, writeState } from '../runtime/state.js'

const CONFIRMATION_TTL_MS = 30 * 60_000
const CONFIRMATION_WORDS = /(?:确认|同意|批准|执行|confirm|approve|execute)/iu

export async function preparePendingPlan(agent, payload, options = {}) {
  const env = options.env ?? process.env
  const sessionKey = requireSessionKey(agent)
  const preparedTurn = currentTurn(agent.session)
  if (preparedTurn < 1) throw new Error('MAA plan preparation requires an open DSH turn')
  const confirmationCode = options.code ?? `MAA-${randomBytes(3).toString('hex').toUpperCase()}`
  const preparedAt = options.now ?? Date.now()
  const confirmationPhrase = `确认执行 ${confirmationCode}`
  const plan = { ...payload, confirmationCode, confirmationPhrase, preparedTurn, preparedAt }

  await prunePendingPlans(CONFIRMATION_TTL_MS, preparedAt, { env })
  await savePendingPlan(sessionKey, plan, { env })

  return {
    confirmationCode,
    confirmationPhrase,
    preparedTurn,
    expiresAt: new Date(preparedAt + CONFIRMATION_TTL_MS).toISOString(),
    persistedAt: stateFilePath(env),
  }
}

export async function consumeConfirmedPlan(exec, confirmationCode, options = {}) {
  const env = options.env ?? process.env
  const sessionKey = requireSessionKey(exec.agent)
  const state = await readState(env)
  const pending = state.plans[sessionKey]
  if (!pending) throw new Error('No pending MAA plan in this DSH session. Prepare the plan again.')

  const now = options.now ?? Date.now()
  if (now - pending.preparedAt > CONFIRMATION_TTL_MS) {
    await dropPlan(sessionKey, env, state)
    throw new Error('The pending MAA plan expired after 30 minutes. Prepare it again.')
  }
  if (confirmationCode !== pending.confirmationCode) throw new Error('The MAA confirmation code does not match the pending plan.')
  const turn = currentTurn(exec.agent.session)
  if (turn <= pending.preparedTurn) throw new Error('The MAA plan cannot be confirmed in the same DSH turn in which it was prepared.')
  const userText = currentTurnHumanText(exec.agent.session)
  if (!userText.includes(confirmationCode) || !CONFIRMATION_WORDS.test(userText)) {
    throw new Error(`The current user message must explicitly contain: ${pending.confirmationPhrase}`)
  }

  await dropPlan(sessionKey, env, state)
  return pending
}

// Read-only view of the pending plan, used to validate confirmation-time
// parameter overrides BEFORE the one-shot plan is consumed. A rejected override
// must not burn the code.
export async function peekPendingPlan(agent, options = {}) {
  const env = options.env ?? process.env
  const sessionKey = requireSessionKey(agent)
  const state = await readState(env)
  const pending = state.plans[sessionKey]
  if (!pending) throw new Error('当前 DSH 会话没有待确认的 MAA 计划，请重新生成计划。')
  return pending
}

// Update preview-only data without changing the confirmation code, creation
// turn, or expiry. The updater cannot consume or replace another Session's plan.
export async function updatePendingPlan(agent, updater, options = {}) {
  if (typeof updater !== 'function') throw new TypeError('pending plan updater must be a function')
  const env = options.env ?? process.env
  const sessionKey = requireSessionKey(agent)
  const state = await readState(env)
  const pending = state.plans[sessionKey]
  if (!pending) throw new Error('当前 DSH 会话没有待确认的 MAA 计划，请重新生成计划。')
  const now = options.now ?? Date.now()
  if (now - pending.preparedAt > CONFIRMATION_TTL_MS) {
    await dropPlan(sessionKey, env, state)
    throw new Error('MAA 计划已超过 30 分钟，请重新生成。')
  }
  const next = await updater(structuredClone(pending))
  if (!next || next.confirmationCode !== pending.confirmationCode || next.preparedAt !== pending.preparedAt) {
    throw new Error('备注预览不能替换确认码或延长有效期。')
  }
  state.plans[sessionKey] = next
  await writeState(state, env)
  return next
}

// Used only by an explicit human gesture in the non-model command plane
// (the /maa confirm command or the confirmation button that invokes it).
// It deliberately does not inspect model-turn text: possession of the code is
// insufficient on its own because the command is scoped to the same Agent.
export async function consumePlanFromHumanGesture(agent, confirmationCode, options = {}) {
  const env = options.env ?? process.env
  const sessionKey = requireSessionKey(agent)
  const state = await readState(env)
  const pending = state.plans[sessionKey]
  if (!pending) throw new Error('当前 DSH 会话没有待确认的 MAA 计划，请重新生成计划。')

  const now = options.now ?? Date.now()
  if (now - pending.preparedAt > CONFIRMATION_TTL_MS) {
    await dropPlan(sessionKey, env, state)
    throw new Error('MAA 计划已超过 30 分钟，请重新生成。')
  }
  if (confirmationCode !== pending.confirmationCode) throw new Error('MAA 确认码不匹配。')

  await dropPlan(sessionKey, env, state)
  return pending
}

export async function clearPendingPlansForTest(env = process.env) {
  await writeState({ version: 1, plans: {} }, env)
}

async function dropPlan(sessionKey, env, state) {
  delete state.plans[sessionKey]
  await writeState(state, env)
}

function requireSessionKey(agent) {
  if (!agent?.session || agent.id === undefined) throw new Error('This MAA tool requires a DSH Agent session')
  return String(agent.id)
}

function currentTurn(session) {
  const event = session.snapshotEvents().findLast(item => item.type === 'turn/start')
  return Number.isInteger(event?.data?.turn) ? event.data.turn : 0
}

function currentTurnHumanText(session) {
  const events = session.snapshotEvents()
  const start = events.findLastIndex(item => item.type === 'turn/start')
  if (start < 0) return ''
  const message = events.slice(start).findLast(item => item.type === 'user/message' && item.data?.source?.kind === 'user')
  if (!message) return ''
  return (message.data.content ?? [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}
