import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { runtimeEnvironment, runtimeLayout } from './runtime.js'

// The fallback is the expected plugin-private runtime path, never a path from
// the developer's machine. If it does not exist yet, maa_runtime install (or
// scripts/install-runtime.mjs) creates it in the current user's DSH home.
export const DEFAULT_MAA_CLI_PATH = runtimeLayout().executable

const RUNTIME_EXECUTABLE_CANDIDATES = Object.freeze(['maa.exe', 'maa-cli.exe', 'maa', 'maa-cli'])

/**
 * Resolution order: an explicit `DSH_MAA_CLI_PATH`/`MAA_CLI_PATH` override,
 * then the plugin's private runtime (so a machine without MAA just works after
 * `maa_runtime install`), then the path of the installation the plugin was
 * originally built for.
 */
export function resolveRuntimeExecutableSync(env = process.env) {
  const layout = runtimeLayout(env)
  for (const name of RUNTIME_EXECUTABLE_CANDIDATES) {
    const candidate = path.join(layout.bin, name)
    if (existsSync(candidate)) return candidate
  }
  return ''
}

export function resolveMaaCliPath(env = process.env) {
  const override = (env.DSH_MAA_CLI_PATH ?? env.MAA_CLI_PATH ?? '').trim()
  if (override !== '') return override
  const runtimeExecutable = resolveRuntimeExecutableSync(env)
  if (runtimeExecutable !== '') return runtimeExecutable
  return runtimeLayout(env).executable
}

export function isRuntimePath(cliPath, env = process.env) {
  if (typeof cliPath !== 'string' || cliPath === '') return false
  // Compare directories rather than file names: archives have shipped the
  // binary as both `maa.exe` and `maa-cli.exe`.
  const { bin } = runtimeLayout(env)
  return path.dirname(path.resolve(cliPath)).toLowerCase() === path.resolve(bin).toLowerCase()
}

export const MAA_CLI_PATH = resolveMaaCliPath()

const QUERY_ARGUMENTS = Object.freeze({
  version: ['version'],
  help: ['--help'],
  list: ['list'],
  library_dir: ['dir', 'library'],
  resource_dir: ['dir', 'resource'],
  config_dir: ['dir', 'config'],
  data_dir: ['dir', 'data'],
  log_dir: ['dir', 'log'],
  cache_dir: ['dir', 'cache'],
  hot_update_dir: ['dir', 'hot-update'],
})

const ACTION_ARGUMENTS = Object.freeze({
  startup: ['startup'],
  closedown: ['closedown'],
})

export function queryArguments(operation) {
  const args = QUERY_ARGUMENTS[operation]
  if (args === undefined) throw new TypeError(`Unsupported maa-cli query: ${operation}`)
  return [...args]
}

export function actionArguments(action, taskName, batch = false, userResource = false) {
  const fixed = ACTION_ARGUMENTS[action]
  if (fixed !== undefined) return [...fixed]
  if (action !== 'run_task') throw new TypeError(`Unsupported maa-cli action: ${action}`)
  if (typeof taskName !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(taskName)) {
    throw new TypeError('taskName must use 1-64 ASCII letters, digits, dot, underscore, or hyphen')
  }
  return ['run', taskName, ...(userResource ? ['--user-resource'] : []), ...(batch ? ['--batch'] : [])]
}

/**
 * Run a maa-cli query or short action and wait for it.
 *
 * Same validation, environment and process-tree termination rules as
 * `startMaa`; `timeoutMs` (default 30 s) becomes the hard ceiling.
 */
export async function runMaa(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive')
  const { timeoutMs: _ignored, ...rest } = options
  return await startMaa(args, { ...rest, hardTimeoutMs: timeoutMs }).done
}

/**
 * Start a maa-cli process without waiting for it.
 *
 * A long task (`maa run task --batch`) can take far longer than a command-plane
 * call is allowed to live, so the caller starts it here, returns to the user
 * immediately and settles the run record from the returned `done` promise.
 *
 * `outputLimit` caps the bytes kept from stdout + stderr. By default exceeding
 * it terminates the process (a structured scan needs its complete output).
 * With `keepOutputTail: true` the oldest output is dropped instead and the
 * process keeps running: a multi-hour task must not be killed for being
 * chatty. The result then reports `outputTruncated: true`.
 */
export function startMaa(args, options = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.some(arg => !/^[A-Za-z0-9._-]+$/.test(arg))) {
    throw new TypeError('maa-cli arguments must come from the validated command map')
  }
  const hardTimeoutMs = options.hardTimeoutMs ?? 6 * 60 * 60_000
  const outputLimit = options.outputLimit ?? 131_072
  const keepOutputTail = options.keepOutputTail === true
  const signal = options.signal
  if (!Number.isFinite(hardTimeoutMs) || hardTimeoutMs <= 0) throw new TypeError('hardTimeoutMs must be positive')
  if (!Number.isFinite(outputLimit) || outputLimit <= 0) throw new TypeError('outputLimit must be positive')
  if (signal?.aborted) throw abortError()

  const cliPath = options.cliPath ?? resolveMaaCliPath()
  const command = `call "${cliPath}" ${args.join(' ')}`
  const commandProcessor = process.env.ComSpec || String.raw`C:\Windows\System32\cmd.exe`
  // A runtime-managed maa-cli must see the runtime directories, otherwise it
  // would install and read resources from the user's global MAA folders.
  const childEnv = { ...(options.env ?? process.env) }
  if (options.env === undefined && isRuntimePath(cliPath)) {
    Object.assign(childEnv, runtimeEnvironment(runtimeLayout()))
  }
  Object.assign(childEnv, options.envPatch ?? {})

  const child = spawnMaaProcess(cliPath, args, command, commandProcessor, childEnv)
  const output = createOutputBuffer(outputLimit, keepOutputTail)
  let state = 'running'
  let exited = false

  // The first stop decides how the run is reported (aborted / timed out). A
  // repeated stop re-issues the tree kill: if the first attempt could not
  // terminate the tree, the user must be able to try again.
  const stop = nextState => {
    if (exited) return Promise.resolve({ ok: true, exited: true, detail: '进程已经退出。' })
    if (state === 'running') state = nextState
    return terminateProcessTree(child)
  }
  const onAbort = () => { void stop('aborted') }
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { void stop('timed-out') }, hardTimeoutMs)

  const collect = stream => chunk => {
    // Once stopping, later chunks are dropped without issuing another kill.
    if (state !== 'running') return
    if (!output.push(stream, chunk)) void stop('output-limit')
  }
  child.stdout.on('data', collect('stdout'))
  child.stderr.on('data', collect('stderr'))

  const done = new Promise((resolve, reject) => {
    child.on('error', error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code, terminationSignal) => {
      exited = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (state === 'aborted') return reject(abortError())
      if (state === 'timed-out') return reject(new Error(`maa-cli timed out after ${hardTimeoutMs} ms`))
      if (state === 'output-limit') return reject(new Error(`maa-cli output exceeded ${outputLimit} bytes`))
      const { stdout, stderr, truncated } = output.result()
      resolve({
        command: `${cliPath} ${args.join(' ')}`,
        exitCode: typeof code === 'number' ? code : -1,
        terminationSignal: terminationSignal ?? '',
        stdout,
        stderr,
        ...(keepOutputTail ? { outputTruncated: truncated } : {}),
      })
    })
  })
  // Keep the process handle alive until it exits even when nobody awaits it
  // immediately; `done` is awaited by the caller's settlement code.
  done.catch(() => {})
  return {
    pid: child.pid ?? null,
    done,
    kill: () => stop('aborted'),
    get exited() { return exited },
  }
}

// Bytes from both streams share one budget, in arrival order. In tail mode the
// oldest bytes are discarded (possibly mid-chunk) so the newest `limit` bytes
// survive; otherwise `push` returns false once the budget is exceeded.
function createOutputBuffer(limit, keepTail) {
  const entries = []
  let bytes = 0
  let truncated = false
  return {
    push(stream, chunk) {
      if (!keepTail && bytes + chunk.length > limit) return false
      entries.push({ stream, chunk })
      bytes += chunk.length
      while (keepTail && bytes > limit) {
        truncated = true
        const excess = bytes - limit
        const first = entries[0]
        if (first.chunk.length <= excess) {
          entries.shift()
          bytes -= first.chunk.length
        } else {
          first.chunk = first.chunk.subarray(excess)
          bytes -= excess
        }
      }
      return true
    },
    result() {
      const pick = stream => Buffer.concat(entries.filter(entry => entry.stream === stream).map(entry => entry.chunk)).toString('utf8').trimEnd()
      return { stdout: pick('stdout'), stderr: pick('stderr'), truncated }
    },
  }
}

function spawnMaaProcess(cliPath, args, command, commandProcessor, childEnv) {
  if (process.platform === 'win32') {
    // Passing /c as a separate spawn argument makes Node escape the quotes around
    // a .cmd path. Let cmd.exe receive the already validated command as one unit.
    return spawn(command, {
      shell: commandProcessor,
      windowsHide: true,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  // POSIX (development / CI): no shell at all, and a dedicated process group so
  // the whole tree can be terminated exactly like taskkill /T does on Windows.
  return spawn(cliPath, args, {
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// Returns a promise that settles once the kill attempt itself has finished.
// It does not wait for the child to exit; callers observe that through `close`.
function terminateProcessTree(child) {
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    // runMaa starts through cmd.exe so the actual maa executable is a child.
    // taskkill /T targets only this exact process tree; it does not touch the
    // emulator, game, MAA GUI, or another independently launched maa-cli.
    return new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const errors = []
      killer.stderr?.on('data', chunk => errors.push(chunk))
      killer.on('error', error => {
        try { child.kill() } catch {}
        resolve({ ok: false, detail: `taskkill 无法启动：${error.message}` })
      })
      killer.on('close', code => {
        // 128 = "process not found": the tree already exited, which is success.
        if (code === 0 || code === 128) return resolve({ ok: true, detail: '' })
        resolve({ ok: false, detail: `taskkill 退出码 ${code}：${Buffer.concat(errors).toString('utf8').trim()}`.trim() })
      })
    })
  }
  if (Number.isInteger(child.pid) && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return Promise.resolve({ ok: true, detail: '' })
    } catch (error) {
      if (error?.code === 'ESRCH') return Promise.resolve({ ok: true, detail: '' })
    }
  }
  try { child.kill('SIGKILL') } catch {}
  return Promise.resolve({ ok: true, detail: '' })
}

function abortError() {
  const error = new Error('maa-cli execution was cancelled')
  error.name = 'AbortError'
  return error
}
