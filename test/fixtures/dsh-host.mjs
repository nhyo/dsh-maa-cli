// A stand-in DSH Desktop host process for lifecycle tests: it loads the real
// plugin entry, registers its /maa command and answers command-plane calls from
// the parent test over IPC. Killing this process is a faithful "DSH crashed or
// restarted" — the maa child it spawned keeps running, exactly like on Windows.
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const entry = pathToFileURL(path.resolve(process.argv[2])).href
const { apply } = await import(entry)
const commands = []
const tools = []
const routes = []
// A minimal DSH web server and Connection fence, shaped like the real ones:
// the plugin registers a prefix route and checks each request with
// `connection.requestRejection` (undefined = admitted).
const webServer = { register: route => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } }
const connection = { requestRejection: () => undefined }
apply({
  tools: { register: tool => tools.push(tool) },
  commands: { register: command => commands.push(command) },
  inject: (deps, callback) => { if (deps.every(dep => ['connection', 'webServer'].includes(dep))) callback({ connection, webServer }) },
})
const maa = commands.find(command => command.name === 'maa')

// What DSH's browser `connection.rpc.call` does on the wire: POST the
// client-request envelope to `<channel>/<endpoint>` and unwrap `result`.
async function callRpc(channel, endpoint, payload) {
  const url = `${channel}/${endpoint}`
  const route = routes.find(item => url === item.path || url.startsWith(`${item.path}/`))
  if (!route) throw new Error(`transport failure for ${url}: HTTP 404`)
  const rpcId = `rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const body = Buffer.from(JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }))
  const req = {
    url, method: 'POST',
    headers: { host: '127.0.0.1:4173', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield body },
  }
  const reply = await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end: text => resolve({ status: res.statusCode, text: String(text ?? '') }),
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
  if (reply.status !== 200) throw new Error(`transport failure for ${url}: HTTP ${reply.status}`)
  const envelope = JSON.parse(reply.text)
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error('invalid server-response envelope')
  return envelope.result
}

function agentFor(sessionId) {
  return { id: sessionId, session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] } }
}

process.on('message', async message => {
  if (message?.type === 'rpc') {
    try {
      process.send({ type: 'result', id: message.id, result: await callRpc(message.channel, message.endpoint, message.payload) })
    } catch (error) {
      process.send({ type: 'result', id: message.id, error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (message?.type === 'tool') {
    // What the model does: call a registered tool directly (no command plane).
    try {
      const tool = tools.find(item => item.name === message.name)
      const result = await tool.execute(message.args, { agent: agentFor(message.sessionId), signal: AbortSignal.timeout(120_000), concludeTurn() {} })
      process.send({ type: 'result', id: message.id, result })
    } catch (error) {
      process.send({ type: 'result', id: message.id, error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (message?.type !== 'execute') return
  const raw = String(message.line ?? '').replace(/^\/maa\s*/u, '')
  try {
    const result = await maa.handler({ agent: agentFor(message.sessionId), rawInput: raw, signal: AbortSignal.timeout(120_000) })
    process.send({ type: 'result', id: message.id, result })
  } catch (error) {
    process.send({ type: 'result', id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
})
process.send({ type: 'ready', pid: process.pid })
