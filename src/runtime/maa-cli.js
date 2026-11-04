// Locate the maa-cli the plugin runs, bootstrapping the private runtime on first use.
import { queryArguments, resolveMaaCliPath, runMaa } from './runner.js'
import { bootstrapRuntime, exists } from './runtime.js'
import { parseMaaCompatibility } from '../strategy/memory.js'

export const MISSING_CLI_HINT = '找不到 maa-cli。可以执行 maa_runtime 的 install 动作：插件会自动下载一套私有运行时（maa-cli + MaaCore + 资源，约 520–630 MB），之后无需在系统里安装 MAA。'

export let runtimeBootstrapPromise = null

export async function requireMaaCli() {
  const cli = resolveMaaCliPath()
  if (!(await exists(cli))) throw new Error(`${MISSING_CLI_HINT}（当前路径：${cli}）`)
  return cli
}

export async function ensureMaaCli(signal, onBootstrapStart) {
  const current = resolveMaaCliPath()
  if (await exists(current)) return current

  // An explicit but missing override is a configuration error. Do not hide it
  // by downloading another runtime that the override would continue to mask.
  const explicit = (process.env.DSH_MAA_CLI_PATH ?? process.env.MAA_CLI_PATH ?? '').trim()
  if (explicit !== '') throw new Error(`指定的 maa-cli 不存在：${explicit}`)

  await onBootstrapStart?.()
  if (runtimeBootstrapPromise === null) {
    runtimeBootstrapPromise = bootstrapRuntime({ run: runMaa, signal })
      .finally(() => { runtimeBootstrapPromise = null })
  }
  await runtimeBootstrapPromise
  return await requireMaaCli()
}

export async function inspectMaaCompatibility(cliPath, signal) {
  const result = await runMaa(queryArguments('version'), { cliPath, signal, timeoutMs: 20_000 })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `maa-cli version exit ${result.exitCode}`)
  return parseMaaCompatibility(`${result.stdout}\n${result.stderr}`)
}
