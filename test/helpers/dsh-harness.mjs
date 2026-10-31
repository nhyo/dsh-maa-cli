import { fork } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createMiniReact, findAll, textOf, visibleText } from './mini-react.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..', '..')
export const FAKE_MAA = path.join(projectRoot, 'test', 'fixtures', 'fake-maa.mjs')
const HOST = path.join(projectRoot, 'test', 'fixtures', 'dsh-host.mjs')
const ENTRY = path.join(projectRoot, 'src', 'index.js')
const CLIENT = path.join(projectRoot, 'src', 'client', 'index.js')

export async function createWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-lifecycle-'))
  const fakeRoot = path.join(root, 'maa')
  await mkdir(fakeRoot, { recursive: true })
  let wrapper
  if (process.platform === 'win32') {
    wrapper = path.join(root, 'fake-maa.cmd')
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${FAKE_MAA}" %*\r\n`)
  } else {
    wrapper = path.join(root, 'fake-maa')
    await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_MAA}" "$@"\n`)
    await chmod(wrapper, 0o755)
  }
  const env = {
    ...process.env,
    DSH_MAA_CLI_STATE_DIR: path.join(root, 'state'),
    DSH_MAA_CLI_PATH: wrapper,
    FAKE_MAA_ROOT: fakeRoot,
    DSH_MAA_STOP_TIMEOUT_MS: '4000',
  }
  const hosts = new Set()
  const workspace = {
    root, fakeRoot, env, hosts,
    setMode: mode => writeFile(path.join(fakeRoot, 'mode'), mode),
    async spawnedRuns() {
      try {
        return (await readFile(path.join(fakeRoot, 'runs.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      } catch { return [] }
    },
    startHost: () => startHost(workspace),
  }
  t.after(async () => {
    for (const host of hosts) host.kill()
    // Leave nothing behind even when an assertion failed mid-run.
    for (const run of await workspace.spawnedRuns()) for (const pid of [run.pid, run.child, run.grandchild]) killQuietly(pid)
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  return workspace
}

export function killQuietly(pid) {
  if (!Number.isInteger(pid)) return
  try { process.kill(pid, 'SIGKILL') } catch {}
}

export function isAlive(pid) {
  if (!Number.isInteger(pid)) return false
  try { process.kill(pid, 0) } catch (error) { return error?.code === 'EPERM' }
  // On Linux a killed process whose parent already exited can linger as a
  // zombie until init reaps it; it no longer runs anything.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
      if (state === 'Z' || state === 'X') return false
    } catch { return false }
  }
  return true
}

export async function waitFor(predicate, timeoutMs = 10_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function startHost(workspace) {
  const child = fork(HOST, [ENTRY], { env: workspace.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const pending = new Map()
  let nextId = 1
  const log = []
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.on('message', message => {
      if (message?.type === 'ready') resolve(message.pid)
      if (message?.type === 'result') {
        const entry = pending.get(message.id)
        pending.delete(message.id)
        if (!entry) return
        if (message.error) entry.reject(new Error(message.error))
        else entry.resolve(message.result)
      }
    })
  })
  const host = {
    pid: await ready,
    log,
    alive: true,
    execute(sessionId, line) {
      if (!host.alive) return Promise.reject(new Error('DSH host is not running'))
      const id = nextId++
      log.push({ sessionId, line })
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.send({ type: 'execute', id, sessionId, line })
      })
    },
    // SIGKILL: no cleanup code in the plugin gets to run — like a crash.
    kill() {
      if (!host.alive) return
      host.alive = false
      try { child.kill('SIGKILL') } catch {}
      for (const entry of pending.values()) entry.reject(new Error('DSH host terminated'))
      pending.clear()
    },
  }
  child.on('exit', () => { host.alive = false })
  workspace.hosts.add(host)
  return host
}

export function createLocalStorage() {
  const values = new Map()
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: key => { values.delete(key) },
    keys: () => [...values.keys()],
  }
}

// Load the real client module (a fresh page) against a host. `confirmAnswer`
// decides what window.confirm returns for the close buttons.
export function loadClient({ host, localStorage, confirmAnswer = () => true }) {
  // `host` is a ref ({ current }) so a test can swap in a restarted host.
  const mini = createMiniReact()
  const source = readFileSync(CLIENT, 'utf8')
  let registration
  const document = {
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild() {} },
  }
  const confirmCalls = []
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document,
    localStorage,
    confirm: message => { confirmCalls.push(message); return confirmAnswer(message) },
    // The run clock is cosmetic; a real interval would keep the test alive.
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask, Promise, Date, Set, Map, String, Number, Boolean, Array, Object, JSON, Symbol, Error, RegExp, Math,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
  })
  vm.runInContext(source, context)
  const module = registration.factory(name => name === 'react' ? mini.React : {})
  const slots = []
  const listeners = new Map()
  const ctx = {
    slots: {
      inject: (name, factory) => slots.push(factory()),
      register: (spec, Component) => ({ spec, Component }),
    },
    remote: {
      commands: {
        async execute(sessionId, line) {
          const result = await host.current.execute(sessionId, line)
          // DSH announces every command result to the client.
          for (const listener of listeners.get('command/executed') ?? []) listener(sessionId, 'maa', result)
          return { ok: true, value: { result } }
        },
      },
    },
    on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
  }
  module.apply(ctx)
  const dockSlot = slots.find(item => item.spec.name === 'conversation.input.dock')
  const cardSlots = slots.filter(item => item.spec.name === 'tool.call.toolview')
  let activeSession = null
  let cards = []
  const view = {
    mini,
    confirmCalls,
    // Show one conversation: its composer dock plus any tool cards.
    show(sessionId) {
      activeSession = sessionId
      mini.mount(() => {
        if (activeSession === null) return null
        const dockProps = dockSlot.spec.inject(activeSession)
        return mini.React.createElement('main', null,
          cards.filter(card => card.sessionId === activeSession).map((card, index) => {
            const props = { ...cardSlots[0].spec.inject(card.sessionId), phase: 'result', block: card.block }
            return mini.React.createElement(cardSlots[0].Component, { ...props, key: `card-${index}` })
          }),
          mini.React.createElement(dockSlot.Component, dockProps))
      })
    },
    addToolCard(sessionId, text) {
      cards.push({ sessionId, block: { content: [{ type: 'text', text }], call: { argsRaw: JSON.stringify({ purpose: '工具卡片计划' }) }, time: Date.now() + 1000, isError: false } })
      view.show(activeSession)
    },
    hide() { activeSession = null; mini.mount(() => null) },
    tree: () => mini.tree(),
    dock: () => findAll(mini.tree(), node => node.props?.['data-maa-dock'])[0] ?? null,
    text: () => textOf(mini.tree()),
    visibleText: () => visibleText(mini.tree()),
    buttons: (action, scope) => findAll(scope ?? mini.tree(), node => node.type === 'button' && (!action || node.props['data-maa-action'] === action)),
    button(action, scope) {
      const found = view.buttons(action, scope)
      if (!found.length) throw new Error(`no ${action} button in: ${textOf(scope ?? mini.tree())}`)
      return found[0]
    },
    click(action, scope) {
      const button = view.button(action, scope)
      if (button.props.disabled) throw new Error(`${action} button is disabled`)
      return button.props.onClick({ preventDefault() {} })
    },
    inputs: () => findAll(mini.tree(), node => node.type === 'input'),
    async settle(ms = 30) {
      for (let index = 0; index < 5; index += 1) await new Promise(resolve => setTimeout(resolve, ms / 5))
    },
  }
  return view
}
