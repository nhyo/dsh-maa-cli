import { parseAddress, parseProfile, probePort, readProfile } from './doctor.js'
import { resolveEffectivePath } from './paths.js'
import { queryArguments, runMaa } from './runner.js'

/** The exact sentence the user asked for when the emulator is not running. */
export const MUMU_NOT_RUNNING_MESSAGE = '请手动启动mumu模拟器！'

/**
 * Resolve the emulator endpoint maa-cli would use: the config directory comes
 * from maa-cli itself, then `default.toml` supplies `connection.address`.
 * Both steps degrade to "unknown" instead of throwing, because the emulator
 * check must never replace maa-cli's own diagnostics with a plugin error.
 */
export async function resolveEmulatorEndpoint(options = {}) {
  const runMaaImpl = options.runMaa ?? runMaa
  const env = options.env ?? process.env

  let configDir = ''
  try {
    const result = await runMaaImpl(queryArguments('config_dir'), { signal: options.signal, timeoutMs: 20_000 })
    configDir = result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/).pop().trim() : ''
  } catch {
    configDir = ''
  }
  if (configDir === '') return { found: false, profilePath: '', profile: { adbPath: '', address: '', config: '' }, endpoint: null }

  const effective = await resolveEffectivePath(configDir, env)
  const found = await readProfile(effective.path)
  const profile = parseProfile(found.text)
  return {
    found: found.path !== '',
    profilePath: found.path,
    profile,
    endpoint: parseAddress(profile.address),
  }
}

/**
 * Check whether the emulator's ADB endpoint accepts connections.
 *
 * `ok: false` is reported only for a definite answer — a parsed address whose
 * port is closed. A missing profile or unparsable address stays `ok: true` so
 * an unusual setup is still handled by maa-cli's own error output.
 */
export async function checkEmulator(options = {}) {
  const isPortOpen = options.isPortOpen ?? probePort
  const resolved = await resolveEmulatorEndpoint(options)
  const base = { profilePath: resolved.profilePath, address: resolved.profile.address, endpoint: resolved.endpoint }

  if (!resolved.found) return { ok: true, reason: 'no-profile', ...base }
  if (resolved.endpoint === null) return { ok: true, reason: 'no-address', ...base }

  const reachable = await isPortOpen(resolved.endpoint.host, resolved.endpoint.port)
  return { ok: reachable, reason: reachable ? 'reachable' : 'port-closed', ...base }
}

export function emulatorErrorMessage(result) {
  const where = result?.endpoint ? `${result.endpoint.host}:${result.endpoint.port}` : 'ADB 端口'
  return [
    MUMU_NOT_RUNNING_MESSAGE,
    `${where} 无法连接：模拟器当前没有运行，或没有开启 ADB 调试。`,
    '启动 MuMu 模拟器后，重新发送一次确认码即可执行（计划仍然保留，不会消耗）。',
  ].join('\n')
}
