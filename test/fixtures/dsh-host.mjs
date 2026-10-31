// A stand-in DSH Desktop host process for lifecycle tests: it loads the real
// plugin entry, registers its /maa command and answers command-plane calls from
// the parent test over IPC. Killing this process is a faithful "DSH crashed or
// restarted" — the maa child it spawned keeps running, exactly like on Windows.
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const entry = pathToFileURL(path.resolve(process.argv[2])).href
const { apply } = await import(entry)
const commands = []
apply({ tools: { register() {} }, commands: { register: command => commands.push(command) } })
const maa = commands.find(command => command.name === 'maa')

function agentFor(sessionId) {
  return { id: sessionId, session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] } }
}

process.on('message', async message => {
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
