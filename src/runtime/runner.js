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

export async function runMaa(args, options = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.some(arg => !/^[A-Za-z0-9._-]+$/.test(arg))) {
    throw new TypeError('maa-cli arguments must come from the validated command map')
  }
  const timeoutMs = options.timeoutMs ?? 30_000
  const outputLimit = options.outputLimit ?? 131_072
  const signal = options.signal
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive')
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

  return await new Promise((resolve, reject) => {
    // Passing /c as a separate spawn argument makes Node escape the quotes around
    // a .cmd path. Let cmd.exe receive the already validated command as one unit.
    const child = spawn(command, {
      shell: commandProcessor,
      windowsHide: true,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let state = 'running'

    const stop = nextState => {
      if (state !== 'running') return
      state = nextState
      terminateProcessTree(child)
    }
    const onAbort = () => stop('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => stop('timed-out'), timeoutMs)

    const collect = destination => chunk => {
      outputBytes += chunk.length
      if (outputBytes > outputLimit) {
        stop('output-limit')
        return
      }
      destination.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))

    child.on('error', error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (state === 'aborted') return reject(abortError())
      if (state === 'timed-out') return reject(new Error(`maa-cli timed out after ${timeoutMs} ms`))
      if (state === 'output-limit') return reject(new Error(`maa-cli output exceeded ${outputLimit} bytes`))
      resolve({
        command: `${cliPath} ${args.join(' ')}`,
        exitCode: typeof code === 'number' ? code : -1,
        terminationSignal: terminationSignal ?? '',
        stdout: Buffer.concat(stdout).toString('utf8').trimEnd(),
        stderr: Buffer.concat(stderr).toString('utf8').trimEnd(),
      })
    })
  })
}

function terminateProcessTree(child) {
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    // runMaa starts through cmd.exe so the actual maa executable is a child.
    // taskkill /T targets only this exact process tree; it does not touch the
    // emulator, game, MAA GUI, or another independently launched maa-cli.
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.on('error', () => { child.kill() })
    killer.unref()
    return
  }
  child.kill()
}

function abortError() {
  const error = new Error('maa-cli execution was cancelled')
  error.name = 'AbortError'
  return error
}
