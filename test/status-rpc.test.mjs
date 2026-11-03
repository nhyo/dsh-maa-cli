import assert from 'node:assert/strict'
import test from 'node:test'
import { createStatusRpcHandler, createStatusRpcRoute, STATUS_RPC_CHANNEL, STATUS_RPC_ENDPOINT } from '../src/commands/status-rpc.js'

test('the status endpoint answers one session snapshot in the Connection result shape', async () => {
  assert.equal(STATUS_RPC_CHANNEL, '/dsh-maa-cli')
  // DSH's client rejects channels that are not one path segment, and the reserved /api.
  assert.match(STATUS_RPC_CHANNEL, /^\/[A-Za-z0-9._~-]+$/u)
  const sessions = []
  const handler = createStatusRpcHandler({ readStatus: async session => { sessions.push(session); return { running: null, session } } })

  assert.deepEqual(await handler(STATUS_RPC_ENDPOINT, { session: 'session-a' }), { ok: true, value: { running: null, session: 'session-a' } })
  assert.deepEqual(sessions, ['session-a'])

  const unknown = await handler('stop', { session: 'session-a' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'dsh-maa-cli/not-found')
  for (const payload of [undefined, {}, { session: '' }, { session: 'a b' }, { session: 42 }]) {
    const rejected = await handler(STATUS_RPC_ENDPOINT, payload)
    assert.equal(rejected.ok, false)
    assert.deepEqual(rejected.error.details, {}, 'DSH requires an object details field on failures')
  }
  assert.equal(sessions.length, 1, 'rejected calls never read state')
})

function request({ path = `${STATUS_RPC_CHANNEL}/status`, method = 'POST', type = 'application/json', body } = {}) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? { type: 'client-request', rpcId: 'r-1', method: 'status', payload: { session: 'session-a' } }))
  return { url: path, method, headers: { host: '127.0.0.1:3080', 'content-type': type }, async *[Symbol.asyncIterator]() { yield bytes } }
}

function serve(route, req) {
  return new Promise(resolve => {
    const res = { statusCode: 200, setHeader() {}, end: text => resolve({ status: res.statusCode, text: String(text ?? '') }) }
    route(req, res)
  })
}

test('the route speaks the Connection wire format and leaves authentication to DSH', async () => {
  let reads = 0
  const readStatus = async session => { reads += 1; return { running: null, session } }
  const admitted = createStatusRpcRoute({ readStatus, connection: () => ({ requestRejection: () => undefined }) })

  const ok = await serve(admitted, request())
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.text), { type: 'server-response', rpcId: 'r-1', result: { ok: true, value: { running: null, session: 'session-a' } } })

  const mismatch = JSON.parse((await serve(admitted, request({ body: { type: 'client-request', rpcId: 'r-2', method: 'stop', payload: {} } }))).text)
  assert.equal(mismatch.rpcId, 'r-2')
  assert.equal(mismatch.result.error.code, 'gateway/bad-request')
  assert.equal((await serve(admitted, request({ method: 'GET' }))).status, 404)
  assert.equal((await serve(admitted, request({ path: '/dsh-maa-cli' }))).status, 404)
  assert.equal((await serve(admitted, request({ type: 'text/plain' }))).status, 415)
  assert.equal((await serve(admitted, request({ body: '{oops' }))).status, 400)
  assert.equal(reads, 1)

  // DSH's fence decides: 401 without a browser session, 403 for an untrusted host.
  for (const code of [401, 403]) {
    const fenced = createStatusRpcRoute({ readStatus, connection: () => ({ requestRejection: () => code }) })
    assert.equal((await serve(fenced, request())).status, code)
  }
  const throwing = createStatusRpcRoute({ readStatus, connection: () => ({ requestRejection: () => { throw new Error('boom') } }) })
  assert.equal((await serve(throwing, request())).status, 403, 'a throwing fence fails closed')
  const missing = createStatusRpcRoute({ readStatus, connection: () => null })
  assert.equal((await serve(missing, request())).status, 503, 'no fence, no answer')
  assert.equal(reads, 1, 'refused requests never read state')
})
