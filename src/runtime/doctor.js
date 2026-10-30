import { lstat, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import { queryArguments, runMaa } from './runner.js'
import { resolveEffectivePath } from './paths.js'

const PROBE_PREFIX = '.maa-doctor-probe'
const PORT_TIMEOUT_MS = 1_500

export const DOCTOR_DIR_QUERIES = Object.freeze({
  cache: 'cache_dir',
  hotUpdate: 'hot_update_dir',
  config: 'config_dir',
  library: 'library_dir',
})

/**
 * Parse `maa-cli version` output. Both executables may be missing on a broken
 * install, so every field degrades to an empty string instead of throwing.
 */
export function parseVersionOutput(text) {
  const source = String(text ?? '')
  const cli = /maa-cli\s+v?([0-9][0-9A-Za-z.+-]*)/i.exec(source)
  const core = /MaaCore\s+v?([0-9][0-9A-Za-z.+-]*)/i.exec(source)
  return { cli: cli ? cli[1] : '', core: core ? core[1] : '' }
}

/**
 * Minimal TOML reader for the fixed profile shape maa-cli writes. Only the
 * three connection keys matter for diagnostics, and TOML basic strings escape
 * backslashes, so a literal `\\` must become a single `\`.
 */
export function parseProfile(text) {
  const pick = key => {
    const match = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(String(text ?? ''))
    if (match === null) return ''
    return match[1].replace(/\\(["\\])/g, '$1')
  }
  return { adbPath: pick('adb_path'), address: pick('address'), config: pick('config') }
}

/**
 * Split an adb server address such as `127.0.0.1:16384` or `[::1]:5555`.
 */
export function parseAddress(address) {
  const match = /^\[?([^\]]*?)\]?:(\d{1,5})$/.exec(String(address ?? '').trim())
  if (match === null) return null
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const host = match[1].trim() === '' ? '127.0.0.1' : match[1]
  return { host, port }
}

/**
 * MuMu 12 ships `MuMuManager.exe` either next to the bundled adb
 * (`<root>\nx_main\`) or at the install root, so probe both derived locations
 * instead of hard-coding an install path.
 */
export function muMuManagerCandidates(adbPath) {
  const trimmed = String(adbPath ?? '').trim()
  if (trimmed === '') return []
  const nxMain = path.dirname(trimmed)
  const root = path.dirname(nxMain)
  return [path.join(nxMain, 'MuMuManager.exe'), path.join(root, 'MuMuManager.exe')]
}

/**
 * maa-cli writes every cache entry by creating a temporary file next to the
 * destination and renaming it into place. On an EFS-encrypted directory that
 * rename fails with EXDEV ("cross-device link"), which is the dominant
 * real-world failure this doctor exists to catch, so probe it directly.
 */
export async function atomicRenameProbe(directory) {
  const suffix = `${PROBE_PREFIX}-${process.pid}-${Date.now()}`
  const temporary = path.join(directory, `${suffix}.tmp`)
  const destination = path.join(directory, `${suffix}.ok`)
  try {
    await writeFile(temporary, 'probe', 'utf8')
    await rename(temporary, destination)
    return { ok: true }
  } catch (error) {
    return { ok: false, code: error?.code ?? '', message: error?.message ?? String(error) }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
    await rm(destination, { force: true }).catch(() => {})
  }
}

export function probePort(host, port, timeoutMs = PORT_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false
    const finish = reachable => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export function summarizeChecks(checks) {
  const failed = checks.filter(check => check.status === 'fail')
  const warned = checks.filter(check => check.status === 'warn')
  const ok = failed.length === 0
  const headline = ok
    ? warned.length === 0
      ? `环境正常：${checks.length} 项检查全部通过`
      : `环境可用，但有 ${warned.length} 项警告`
    : `环境不可用：${failed.length} 项失败（${failed.map(check => check.title).join('、')}）`
  return { ok, headline, failed: failed.map(check => check.id), warned: warned.map(check => check.id) }
}

export function formatReport(report) {
  const icon = status => (status === 'ok' ? 'OK  ' : status === 'warn' ? 'WARN' : 'FAIL')
  const lines = [report.headline, '']
  for (const check of report.checks) {
    lines.push(`[${icon(check.status)}] ${check.title}: ${check.detail}`)
    if (check.hint && check.status !== 'ok') lines.push(`       -> ${check.hint}`)
  }
  return lines.join('\n')
}

function check(id, title, status, detail, hint) {
  return hint === undefined ? { id, title, status, detail } : { id, title, status, detail, hint }
}

async function describePath(directory) {
  try {
    const stats = await lstat(directory)
    if (stats.isSymbolicLink()) {
      const target = await readlink(directory).catch(() => '')
      return { exists: true, link: target }
    }
    return { exists: true, link: '' }
  } catch {
    return { exists: false, link: '' }
  }
}

async function resolveDirs(runMaaImpl, signal, env) {
  const dirs = {}
  for (const [key, operation] of Object.entries(DOCTOR_DIR_QUERIES)) {
    try {
      const result = await runMaaImpl(queryArguments(operation), { signal, timeoutMs: 20_000 })
      dirs[key] = result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/).pop().trim() : ''
    } catch {
      dirs[key] = ''
    }
  }

  // Packaged desktop apps redirect `%APPDATA%`/`%LOCALAPPDATA%` beneath
  // `LocalCache`, and a redirected path can be invisible to directory lookups
  // even though file I/O resolves it. Resolve both views before declaring a
  // directory missing; the literal path is kept for the report.
  const effective = {}
  const redirections = []
  for (const [key, literal] of Object.entries(dirs)) {
    if (literal === '') {
      effective[key] = ''
      continue
    }
    const resolved = await resolveEffectivePath(literal, env)
    effective[key] = resolved.path
    if (resolved.redirectedFrom !== null) redirections.push({ key, literal: resolved.redirectedFrom, path: resolved.path })
  }
  return { dirs, effective, redirections }
}

export async function readProfile(configDir) {
  for (const name of ['default.toml', path.join('profiles', 'default.toml')]) {
    const candidate = path.join(configDir, name)
    try {
      return { path: candidate, text: await readFile(candidate, 'utf8') }
    } catch {
      /* try the next documented location */
    }
  }
  return { path: '', text: '' }
}

export async function runDoctor(options = {}) {
  const runMaaImpl = options.runMaa ?? runMaa
  if (typeof runMaaImpl !== 'function') throw new TypeError('runMaa must be a function')
  const probe = options.probe ?? atomicRenameProbe
  const isPortOpen = options.isPortOpen ?? probePort
  const signal = options.signal
  const checks = []

  let versionText = ''
  try {
    const result = await runMaaImpl(['version'], { signal, timeoutMs: 20_000 })
    versionText = `${result.stdout}\n${result.stderr}`
    const versions = parseVersionOutput(versionText)
    if (result.exitCode !== 0) {
      checks.push(check('cli', 'maa-cli 可执行', 'fail', `退出码 ${result.exitCode}`, '确认 MAA_CLI_PATH 指向可用的 maa-cli.cmd'))
    } else if (versions.cli === '') {
      checks.push(check('cli', 'maa-cli 可执行', 'warn', '无法从 version 输出解析版本号'))
    } else {
      checks.push(check('cli', 'maa-cli 可执行', 'ok', `maa-cli ${versions.cli} / MaaCore ${versions.core || '未知'}`))
    }
  } catch (error) {
    checks.push(check('cli', 'maa-cli 可执行', 'fail', error?.message ?? String(error), '确认 MAA_CLI_PATH 指向可用的 maa-cli.cmd'))
  }

  const { dirs, effective, redirections } = await resolveDirs(runMaaImpl, signal, options.env)

  checks.push(redirections.length === 0
    ? check('redirect', 'AppData 视图', 'ok', 'maa-cli 报告的目录与磁盘视图一致')
    : check(
      'redirect',
      'AppData 视图',
      'warn',
      redirections.map(item => `${item.literal} -> ${item.path}`).join('；'),
      '这些路径被打包应用的 AppData 重定向接管：读写会落到右侧真实位置，属正常现象',
    ))

  if (dirs.library === '') {
    checks.push(check('library', 'MaaCore 目录', 'fail', '无法解析库目录', '检查 maa-cli 安装是否完整'))
  } else {
    const core = await describePath(path.join(effective.library, 'MaaCore.dll'))
    checks.push(core.exists
      ? check('library', 'MaaCore 目录', 'ok', effective.library)
      : check('library', 'MaaCore 目录', 'fail', `${effective.library} 缺少 MaaCore.dll`, '重新安装 MaaCore 或修正库目录'))
  }

  if (dirs.cache === '') {
    checks.push(check('cache', '缓存目录原子写', 'fail', '无法解析缓存目录'))
  } else {
    const info = await describePath(effective.cache)
    if (!info.exists) {
      checks.push(check('cache', '缓存目录原子写', 'fail', `目录不存在：${effective.cache}`, '先运行一次 maa-cli 或手动创建该目录'))
    } else {
      const probed = await probe(effective.cache)
      const where = info.link === '' ? effective.cache : `${effective.cache} -> ${info.link}`
      if (probed.ok) {
        checks.push(check('cache', '缓存目录原子写', 'ok', where))
      } else {
        checks.push(check(
          'cache',
          '缓存目录原子写',
          'fail',
          `${where} 临时文件改名失败（${probed.code || '未知错误'}）`,
          '该目录多半位于 EFS 加密区：把缓存目录迁到未加密卷后建立 junction，或对该目录 cipher /d 解密',
        ))
      }
    }
  }

  if (dirs.hotUpdate === '') {
    checks.push(check('hot-update', '资源热更新仓库', 'warn', '无法解析热更新目录'))
  } else {
    const info = await describePath(effective.hotUpdate)
    if (!info.exists) {
      checks.push(check('hot-update', '资源热更新仓库', 'warn', `目录不存在：${effective.hotUpdate}`, '运行 maa-cli hot-update 初始化资源仓库'))
    } else {
      const gitDir = await describePath(path.join(effective.hotUpdate, '.git'))
      const resourceDir = await describePath(path.join(effective.hotUpdate, 'resource'))
      let fileCount = 0
      try {
        fileCount = (await readdir(path.join(effective.hotUpdate, 'resource'))).length
      } catch {
        fileCount = 0
      }
      if (!gitDir.exists) {
        checks.push(check('hot-update', '资源热更新仓库', 'warn', `${effective.hotUpdate} 不是 git 仓库`, '运行 git clone https://github.com/MaaAssistantArknights/MaaResource.git 到该目录'))
      } else if (!resourceDir.exists || fileCount === 0) {
        checks.push(check('hot-update', '资源热更新仓库', 'warn', `${effective.hotUpdate} 的 resource/ 为空`, '运行 maa-cli hot-update 重新检出资源'))
      } else {
        checks.push(check('hot-update', '资源热更新仓库', 'ok', `${effective.hotUpdate}（resource/ 下 ${fileCount} 项）`))
      }
    }
  }

  let profile = { adbPath: '', address: '', config: '' }
  if (dirs.config === '') {
    checks.push(check('profile', '模拟器连接配置', 'warn', '无法解析配置目录'))
  } else {
    const found = await readProfile(effective.config)
    profile = parseProfile(found.text)
    if (found.path === '') {
      checks.push(check('profile', '模拟器连接配置', 'warn', `未找到 default.toml（${effective.config}）`, '至少运行一次 maa-cli 或由用户提供连接配置'))
    } else if (profile.adbPath === '') {
      checks.push(check('profile', '模拟器连接配置', 'warn', `${found.path} 缺少 adb_path`))
    } else {
      checks.push(check('profile', '模拟器连接配置', 'ok', `adb: ${profile.adbPath} | 地址: ${profile.address || '未知'} | client: ${profile.config || '未知'}`))
    }
  }

  if (profile.adbPath !== '') {
    const adb = await describePath(profile.adbPath)
    checks.push(adb.exists
      ? check('adb', 'ADB 可执行文件', 'ok', profile.adbPath)
      : check('adb', 'ADB 可执行文件', 'fail', `不存在：${profile.adbPath}`, '修正 default.toml 的 adb_path 或安装模拟器自带 adb'))
  } else {
    checks.push(check('adb', 'ADB 可执行文件', 'warn', '配置里没有 adb_path，跳过'))
  }

  const endpoint = parseAddress(profile.address)
  if (endpoint === null) {
    checks.push(check('port', 'ADB 端口监听', 'warn', `无法解析地址：${profile.address || '(空)'}`, '在 default.toml 的 connection.address 写入 host:port'))
  } else {
    const reachable = await isPortOpen(endpoint.host, endpoint.port)
    checks.push(reachable
      ? check('port', 'ADB 端口监听', 'ok', `${endpoint.host}:${endpoint.port} 可连接`)
      : check('port', 'ADB 端口监听', 'fail', `${endpoint.host}:${endpoint.port} 未监听`, '先启动 MuMu 模拟器并启用 ADB 调试'))
  }

  const candidates = muMuManagerCandidates(profile.adbPath)
  if (candidates.length === 0) {
    checks.push(check('mumu', 'MuMu 管理器', 'warn', '没有 adb_path，无法推导 MuMu 管理器位置'))
  } else {
    let found = ''
    for (const candidate of candidates) {
      if ((await describePath(candidate)).exists) {
        found = candidate
        break
      }
    }
    checks.push(found === ''
      ? check('mumu', 'MuMu 管理器', 'warn', `未找到：${candidates.join(' 或 ')}`, 'MuMu 管理器缺失时无法自动启动模拟器，需要手动打开')
      : check('mumu', 'MuMu 管理器', 'ok', found))
  }

  return { ...summarizeChecks(checks), checks }
}
