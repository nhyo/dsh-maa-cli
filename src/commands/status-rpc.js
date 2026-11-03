// Silent run-status channel for the composer dock.
//
// Every `/maa …` command is logged into the session as command/run + command/done,
// so a dock that read its status through `/maa status` echoed a JSON blob into
// the transcript on each read (issue #1) and could not refresh itself. DSH's
// Connection service offers plugin RPC channels instead: the client calls
// `connection.rpc.call(channel, endpoint, payload)` and DSH handles transport
// (Electron or HTTP) and authentication, without touching the transcript.

import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from '../runtime/state.js'

export const STATUS_RPC_CHANNEL = '/dsh-maa-cli'
export const STATUS_RPC_ENDPOINT = 'status'

export function statusRpcMarkerPath(env = process.env) {
  return path.join(stateDirectory(env), 'status-rpc.json')
}

// Diagnostic trail of channel registration for this host process: "applied",
// then "registered" (or "register-failed" / "inject-failed" with the error).
// Each stage is appended, so "is the new plugin code running, and where did
// registration stop?" can be answered from disk.
let registrationTrail = []
let markerWrite = Promise.resolve()
export function recordStatusRpcRegistration({ stage, env = process.env, now = Date.now(), ...details } = {}) {
  // Unit tests apply the plugin without a private state dir; never let them
  // overwrite the real diagnostic file in the user's home.
  if (env.NODE_TEST_CONTEXT && !env.DSH_MAA_CLI_STATE_DIR) return Promise.resolve()
  registrationTrail = [...registrationTrail, { stage, at: new Date(now).toISOString(), ...details }].slice(-10)
  const snapshot = { channel: STATUS_RPC_CHANNEL, pid: process.pid, stage, trail: registrationTrail }
  // Stages arrive back to back; serialize and replace atomically so a reader
  // never sees two writes interleaved.
  const write = markerWrite.then(async () => {
    const target = statusRpcMarkerPath(env)
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`)
    await rename(temporary, target)
  })
  markerWrite = write.catch(() => {})
  return write
}

const SESSION_PATTERN = /^[\w.:-]{1,200}$/u

function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

// Endpoint logic in DSH's RPC result shape: { ok: true, value } or a failure.
export function createStatusRpcHandler({ readStatus }) {
  return async (endpoint, payload) => {
    if (endpoint !== STATUS_RPC_ENDPOINT) return failure('dsh-maa-cli/not-found', `unknown endpoint ${String(endpoint)}`)
    const session = typeof payload?.session === 'string' ? payload.session : ''
    if (!SESSION_PATTERN.test(session)) return failure('dsh-maa-cli/bad-request', 'session required')
    return { ok: true, value: await readStatus(session) }
  }
}

const MAX_REQUEST_BYTES = 64 * 1024

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendStatus(res, status, text) {
  res.statusCode = status
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('request too large'), { status: 413 })
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// A web-server route that speaks DSH's Connection RPC wire format, so the
// client can use the stock `connection.rpc.call(STATUS_RPC_CHANNEL, 'status', …)`.
//
// Why not `connection.rpc.handle`: on DSH 0.2.x it registers through the
// Connection service's own context, which cannot see `webServer` from a
// third-party plugin ("cannot get property "webServer" without inject", seen on
// a real host). `webServer.register` from the plugin's injected context works
// (dsh-whale-widget relies on it), and authentication stays DSH's: every request
// goes through `connection.requestRejection`, the same Host/Origin fence and
// browser-session check the built-in channels use.
export function createStatusRpcRoute({ readStatus, connection }) {
  const handle = createStatusRpcHandler({ readStatus })
  return async (req, res) => {
    const fence = typeof connection === 'function' ? connection() : connection
    if (typeof fence?.requestRejection !== 'function') return sendStatus(res, 503, 'connection unavailable')
    let rejection
    try { rejection = fence.requestRejection(req) } catch { rejection = 403 }
    if (rejection !== undefined && rejection !== null && rejection !== false) {
      return sendStatus(res, typeof rejection === 'number' ? rejection : 403, rejection === 401 ? 'unauthorized' : 'forbidden')
    }
    let pathname
    try { pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname } catch { return sendStatus(res, 400, 'bad url') }
    if (!pathname.startsWith(`${STATUS_RPC_CHANNEL}/`)) return sendStatus(res, 404, 'not found')
    const endpoint = pathname.slice(STATUS_RPC_CHANNEL.length + 1)
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') return sendStatus(res, 404, 'not found')
    const type = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (type !== 'application/json') return sendStatus(res, 415, 'content type must be application/json')
    let message
    try {
      message = await readJsonBody(req)
    } catch (error) {
      return sendStatus(res, error?.status ?? 400, error?.status ? 'request too large' : 'body is not JSON')
    }
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : ''
    if (message?.type !== 'client-request' || rpcId === '' || typeof message.method !== 'string') {
      return sendJson(res, 200, { type: 'server-response', rpcId: rpcId || 'invalid-request', result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } } })
    }
    if (message.method !== endpoint) {
      return sendJson(res, 200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} } } })
    }
    try {
      return sendJson(res, 200, { type: 'server-response', rpcId, result: await handle(endpoint, message.payload) })
    } catch (error) {
      return sendStatus(res, 500, `handler failure: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
