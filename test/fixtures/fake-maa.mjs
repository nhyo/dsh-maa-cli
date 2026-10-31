// A stand-in for maa-cli used by the lifecycle tests. It answers the read-only
// queries the plugin makes and, for `run`, behaves according to
// $FAKE_MAA_ROOT/mode:
//   fast    – print a completed summary and exit 0
//   slow    – keep a child process alive (a real process tree) until killed
//   escape  – POSIX only: also start a grandchild in its own session that keeps
//             stdout open, so killing the process group does NOT end the run
// Every `run` appends {pid, child, grandchild} to $FAKE_MAA_ROOT/runs.jsonl.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.env.FAKE_MAA_ROOT
const args = process.argv.slice(2)
const dirs = { config: 'config', resource: 'resource', log: 'log', data: 'data', cache: 'cache', library: 'library', 'hot-update': 'hot-update' }

if (args[0] === 'version') {
  console.log('maa-cli v0.7.7')
  console.log('MaaCore v6.20.1')
  process.exit(0)
}
if (args[0] === 'dir' && dirs[args[1]]) {
  const target = path.join(root, dirs[args[1]])
  mkdirSync(target, { recursive: true })
  console.log(target)
  process.exit(0)
}
if (args[0] === 'list') process.exit(0)
if (args[0] === 'run') {
  let mode = 'fast'
  try { mode = readFileSync(path.join(root, 'mode'), 'utf8').trim() } catch {}
  if (mode === 'fast') {
    console.log('[Fight] Completed')
    process.exit(0)
  }
  const keepAlive = ['-e', 'setInterval(() => {}, 1000)']
  const child = spawn(process.execPath, keepAlive, { stdio: 'inherit' })
  let grandchild = null
  if (mode === 'escape' && process.platform !== 'win32') {
    grandchild = spawn(process.execPath, keepAlive, { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  }
  appendFileSync(path.join(root, 'runs.jsonl'), `${JSON.stringify({ pid: process.pid, child: child.pid, grandchild: grandchild?.pid ?? null })}\n`)
  console.log('[Fight] Running')
  setInterval(() => {}, 1000)
} else {
  console.error(`fake maa: unsupported ${args.join(' ')}`)
  process.exit(2)
}
