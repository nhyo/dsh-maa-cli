import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const STORE_VERSION = 1
let stateMutation = Promise.resolve()

/**
 * Pending plans live in a small JSON file so a plan prepared in one DSH turn
 * still exists after the desktop app restarts. `DSH_MAA_CLI_STATE_DIR` lets a
 * user (or a test) keep that state somewhere else.
 */
export function stateDirectory(env = process.env) {
  const override = (env.DSH_MAA_CLI_STATE_DIR ?? '').trim()
  return override === '' ? path.join(os.homedir(), '.dsh', 'maa-cli') : path.resolve(override)
}

export function stateFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'pending-plans.json')
}

export async function readState(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath(env), 'utf8'))
    if (parsed?.version !== STORE_VERSION) return emptyState()
    if (typeof parsed.plans !== 'object' || parsed.plans === null || Array.isArray(parsed.plans)) return emptyState()
    // `closed` keeps a short tombstone for every code that was confirmed,
    // cancelled, superseded or expired, so an old code can never be revived and
    // late callers get an exact reason instead of a generic "not found".
    const closed = typeof parsed.closed === 'object' && parsed.closed !== null && !Array.isArray(parsed.closed) ? parsed.closed : {}
    return { version: STORE_VERSION, plans: parsed.plans, closed }
  } catch {
    return emptyState()
  }
}

export async function writeState(state, env = process.env) {
  const file = stateFilePath(env)
  await mkdir(path.dirname(file), { recursive: true })
  const payload = `${JSON.stringify({ version: STORE_VERSION, plans: state.plans, closed: state.closed ?? {} }, null, 2)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, file)
  } catch {
    // Directories that reject rename (EFS-encrypted, some cloud-synced ones)
    // must not make plan bookkeeping fail: fall back to an in-place write.
    await writeFile(file, payload, 'utf8').catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

// Pending-plan writes share one queue so confirmation, cancellation, preview
// updates and plan creation cannot overwrite one another after reading the
// same older snapshot.
export function mutateState(env = process.env, mutate) {
  if (typeof mutate !== 'function') throw new TypeError('state mutator must be a function')
  const operation = stateMutation.then(async () => {
    const state = await readState(env)
    const value = await mutate(state)
    await writeState(state, env)
    return value
  })
  stateMutation = operation.catch(() => {})
  return operation
}

export function prunedPlans(plans, ttlMs, now) {
  const kept = {}
  for (const [sessionKey, plan] of Object.entries(plans)) {
    const preparedAt = Number(plan?.preparedAt)
    if (!Number.isFinite(preparedAt)) continue
    if (now - preparedAt > ttlMs) continue
    kept[sessionKey] = plan
  }
  return kept
}

export async function savePendingPlan(sessionKey, plan, options = {}) {
  const env = options.env ?? process.env
  return await mutateState(env, state => { state.plans[sessionKey] = plan })
}

export async function loadPendingPlan(sessionKey, options = {}) {
  const env = options.env ?? process.env
  const state = await readState(env)
  return state.plans[sessionKey] ?? null
}

export async function dropPendingPlan(sessionKey, options = {}) {
  const env = options.env ?? process.env
  return await mutateState(env, state => { delete state.plans[sessionKey] })
}

export async function prunePendingPlans(ttlMs, now, options = {}) {
  const env = options.env ?? process.env
  return await mutateState(env, state => {
    state.plans = prunedPlans(state.plans, ttlMs, now)
    return state.plans
  })
}

export async function clearStateForTest(env = process.env) {
  await rm(stateFilePath(env), { force: true }).catch(() => {})
}

function emptyState() {
  return { version: STORE_VERSION, plans: {}, closed: {} }
}
