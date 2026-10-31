import { randomBytes } from 'node:crypto'
import { mutateState, prunedPlans, readState, stateFilePath, writeState } from '../runtime/state.js'

const CONFIRMATION_TTL_MS = 30 * 60_000
const CONFIRMATION_WORDS = /(?:确认|同意|批准|执行|confirm|approve|execute)/iu
const EXPIRED = Symbol('expired pending plan')
// Tombstones outlive the 30-minute confirmation window so a late click, a
// replayed command or a stale panel still gets an exact, permanent refusal.
const CLOSED_TTL_MS = 24 * 60 * 60_000
const CLOSED_LIMIT = 500
const CLOSED_REASONS = Object.freeze({
  cancelled: '已被取消',
  confirmed: '已被确认并开始执行',
  superseded: '已被新的计划替换',
  expired: '已超过 30 分钟有效期',
})

function pruneClosed(state, now) {
  const entries = Object.entries(state.closed ?? {})
    .filter(([, entry]) => Number.isFinite(Number(entry?.at)) && now - Number(entry.at) <= CLOSED_TTL_MS)
    .sort((left, right) => Number(right[1].at) - Number(left[1].at))
    .slice(0, CLOSED_LIMIT)
  state.closed = Object.fromEntries(entries)
}

function closeCode(state, sessionKey, plan, status, now, extra = {}) {
  if (!plan?.confirmationCode) return
  pruneClosed(state, now)
  state.closed[plan.confirmationCode] = { sessionKey, status, at: now, purpose: String(plan.purpose ?? plan.planSummary ?? '').slice(0, 200), ...extra }
}

function closedError(code, entry, english = false) {
  const reason = CLOSED_REASONS[entry.status] ?? '已失效'
  const error = new Error(english
    ? `No pending MAA plan for ${code}: the code ${entry.status === 'cancelled' ? 'was cancelled' : entry.status === 'confirmed' ? 'was already confirmed' : entry.status === 'superseded' ? 'was replaced by a newer plan' : 'expired'} and can never be used again.`
    : `当前 DSH 会话没有待确认的 MAA 计划：确认码 ${code} ${reason}，已永久失效。`)
  error.code = `MAA_PLAN_${String(entry.status).toUpperCase()}`
  error.closed = { code, ...entry }
  return error
}

function closedEntryFor(state, sessionKey, code) {
  const entry = code ? state.closed?.[code] : null
  return entry && entry.sessionKey === sessionKey ? entry : null
}

export async function preparePendingPlan(agent, payload, options = {}) {
  const env = options.env ?? process.env
  const sessionKey = requireSessionKey(agent)
  const preparedTurn = currentTurn(agent.session)
  if (preparedTurn < 1) throw new Error('MAA plan preparation requires an open DSH turn')
  const preparedAt = options.now ?? Date.now()
  let confirmationCode = options.code ?? ''
  let plan = null

  await mutateState(env, state => {
    for (const [key, stale] of Object.entries(state.plans)) {
      if (preparedAt - Number(stale?.preparedAt) > CONFIRMATION_TTL_MS) closeCode(state, key, stale, 'expired', preparedAt)
    }
    state.plans = prunedPlans(state.plans, CONFIRMATION_TTL_MS, preparedAt)
    // A generated code must never collide with a recently closed one, or a
    // stale panel could address the new plan with an old code.
    while (confirmationCode === '' || (!options.code && state.closed?.[confirmationCode])) {
      confirmationCode = `MAA-${randomBytes(3).toString('hex').toUpperCase()}`
    }
    const previous = state.plans[sessionKey]
    if (previous && previous.confirmationCode !== confirmationCode) closeCode(state, sessionKey, previous, 'superseded', preparedAt)
    if (state.closed?.[confirmationCode]) delete state.closed[confirmationCode]
    plan = { ...payload, confirmationCode, confirmationPhrase: `确认执行 ${confirmationCode}`, preparedTurn, preparedAt }
    state.plans[sessionKey] = plan
  })
  const confirmationPhrase = plan.confirmationPhrase

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
  const now = options.now ?? Date.now()
  const turn = currentTurn(exec.agent.session)
  const userText = currentTurnHumanText(exec.agent.session)
  const result = await mutateState(env, state => {
    const closed = closedEntryFor(state, sessionKey, confirmationCode)
    if (closed) throw closedError(confirmationCode, closed, true)
    const pending = state.plans[sessionKey]
    if (!pending) throw new Error('No pending MAA plan in this DSH session. Prepare the plan again.')
    if (now - pending.preparedAt > CONFIRMATION_TTL_MS) {
      closeCode(state, sessionKey, pending, 'expired', now)
      delete state.plans[sessionKey]
      return EXPIRED
    }
    if (confirmationCode !== pending.confirmationCode) throw new Error('The MAA confirmation code does not match the pending plan.')
    if (turn <= pending.preparedTurn) throw new Error('The MAA plan cannot be confirmed in the same DSH turn in which it was prepared.')
    if (!userText.includes(confirmationCode) || !CONFIRMATION_WORDS.test(userText)) {
      throw new Error(`The current user message must explicitly contain: ${pending.confirmationPhrase}`)
    }
    closeCode(state, sessionKey, pending, 'confirmed', now, { runId: '' })
    delete state.plans[sessionKey]
    return pending
  })
  if (result === EXPIRED) throw new Error('The pending MAA plan expired after 30 minutes. Prepare it again.')
  return result
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
  const now = options.now ?? Date.now()
  const result = await mutateState(env, async state => {
    const pending = state.plans[sessionKey]
    if (!pending) throw new Error('当前 DSH 会话没有待确认的 MAA 计划，请重新生成计划。')
    if (now - pending.preparedAt > CONFIRMATION_TTL_MS) {
      closeCode(state, sessionKey, pending, 'expired', now)
      delete state.plans[sessionKey]
      return EXPIRED
    }
    const next = await updater(structuredClone(pending))
    if (!next || next.confirmationCode !== pending.confirmationCode || next.preparedAt !== pending.preparedAt) {
      throw new Error('备注预览不能替换确认码或延长有效期。')
    }
    state.plans[sessionKey] = next
    return next
  })
  if (result === EXPIRED) throw new Error('MAA 计划已超过 30 分钟，请重新生成。')
  return result
}

// Used only by an explicit human gesture in the non-model command plane
// (the /maa confirm command or the confirmation button that invokes it).
// It deliberately does not inspect model-turn text: possession of the code is
// insufficient on its own because the command is scoped to the same Agent.
export async function consumePlanFromHumanGesture(agent, confirmationCode, options = {}) {
  const env = options.env ?? process.env
  const sessionKey = requireSessionKey(agent)
  const now = options.now ?? Date.now()
  const result = await mutateState(env, state => {
    const closed = closedEntryFor(state, sessionKey, confirmationCode)
    if (closed) throw closedError(confirmationCode, closed)
    const pending = state.plans[sessionKey]
    if (!pending) throw new Error('当前 DSH 会话没有待确认的 MAA 计划，请重新生成计划。')
    if (now - pending.preparedAt > CONFIRMATION_TTL_MS) {
      closeCode(state, sessionKey, pending, 'expired', now)
      delete state.plans[sessionKey]
      return EXPIRED
    }
    if (confirmationCode !== pending.confirmationCode) throw new Error('MAA 确认码不匹配。')
    closeCode(state, sessionKey, pending, 'confirmed', now, { runId: '' })
    delete state.plans[sessionKey]
    return pending
  })
  if (result === EXPIRED) throw new Error('MAA 计划已超过 30 分钟，请重新生成。')
  return result
}

// Explicit confirmation-panel close. It is scoped to both the DSH session and
// the exact one-shot code, so another session's plan can never be removed. The
// same queue serializes it with confirmation: exactly one of them wins.
//
// Idempotent: closing an already cancelled, superseded or expired code succeeds
// again (`alreadyClosed`). A code that was already confirmed is refused with
// MAA_PLAN_CONFIRMED so the caller knows a run, not a plan, now exists.
export async function cancelPendingPlan(agent, confirmationCode, options = {}) {
  const env = options.env ?? process.env
  const sessionKey = requireSessionKey(agent)
  const now = options.now ?? Date.now()
  return await mutateState(env, state => {
    const closed = closedEntryFor(state, sessionKey, confirmationCode)
    if (closed) {
      if (closed.status === 'confirmed') throw closedError(confirmationCode, closed)
      return { confirmationCode, status: closed.status, alreadyClosed: true, purpose: closed.purpose ?? '' }
    }
    const pending = state.plans[sessionKey]
    if (!pending || confirmationCode !== pending.confirmationCode) {
      if (!pending) {
        const error = new Error('当前 DSH 会话没有待确认的 MAA 计划。')
        error.code = 'MAA_PLAN_NOT_FOUND'
        throw error
      }
      throw new Error('MAA 确认码不匹配，未取消任何计划。')
    }
    const expired = now - pending.preparedAt > CONFIRMATION_TTL_MS
    closeCode(state, sessionKey, pending, expired ? 'expired' : 'cancelled', now)
    delete state.plans[sessionKey]
    return { ...pending, status: expired ? 'expired' : 'cancelled', alreadyClosed: expired }
  })
}

// Attach the run id to a confirmed code's tombstone, so a late "cancel" of a
// plan that already became a run can point at the run to stop instead.
export async function recordPlanRun(agent, confirmationCode, runId, options = {}) {
  const env = options.env ?? process.env
  const sessionKey = requireSessionKey(agent)
  return await mutateState(env, state => {
    const closed = closedEntryFor(state, sessionKey, confirmationCode)
    if (!closed || closed.status !== 'confirmed') return null
    closed.runId = String(runId ?? '')
    return closed
  })
}

export async function closedPlanStatus(agent, confirmationCode, options = {}) {
  const env = options.env ?? process.env
  const state = await readState(env)
  return closedEntryFor(state, requireSessionKey(agent), confirmationCode)
}

// Refuse a closed code with its exact reason before any expensive work.
export async function assertPlanCodeOpen(agent, confirmationCode, options = {}) {
  const closed = await closedPlanStatus(agent, confirmationCode, options)
  if (closed) throw closedError(confirmationCode, closed)
}

export async function clearPendingPlansForTest(env = process.env) {
  await writeState({ version: 1, plans: {}, closed: {} }, env)
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
