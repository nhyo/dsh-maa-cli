// Runtime side of companion plugins: find their services, report their state
// and install them into the active DSH profile.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EXTENSIONS, extensionInstallSpec, findExtension } from './registry.js'

const INSTALL_TIMEOUT_MS = 15 * 60_000
const OUTPUT_TAIL_BYTES = 4096
const SAFE_SPEC = /^[A-Za-z0-9@._/:+~^-]{1,200}$/u

function safeGet(ctx, name) {
  try { return typeof ctx?.get === 'function' ? ctx.get(name) : undefined } catch { return undefined }
}

/**
 * The profile this DSH process runs, as the launcher reports it
 * (`profileContext`: name, directory and the host's own pnpm invocation).
 * Without it the profile cannot be identified reliably, so nothing is
 * installed and the user gets the manual command instead.
 */
export function activeProfile(ctx) {
  const context = safeGet(ctx, 'profileContext')
  const name = typeof context?.name === 'string' ? context.name.trim() : ''
  const dir = typeof context?.dir === 'string' ? context.dir.trim() : ''
  if (name === '' || dir === '' || /[\\/\0]/u.test(name)) return null
  const manager = context.packageManager
  const packageManager = manager && typeof manager.command === 'string' && manager.command.trim() !== ''
    && Array.isArray(manager.args) && manager.args.every(arg => typeof arg === 'string')
    ? {
      command: manager.command,
      args: [...manager.args],
      env: Object.fromEntries(Object.entries(manager.env ?? {}).filter(([, value]) => typeof value === 'string')),
    }
    : null
  return { name, dir, packageManager }
}

export function extensionStatus(ctx, entry, profile = activeProfile(ctx)) {
  const base = { id: entry.id, packageName: entry.packageName, title: entry.title }
  const service = safeGet(ctx, entry.service)
  if (service && typeof service === 'object') {
    if (service.apiVersion !== entry.apiVersion) {
      return { ...base, state: 'incompatible', version: String(service.version ?? ''), detail: `辅助插件接口版本为 ${service.apiVersion}，dsh-maa-cli 需要 ${entry.apiVersion}。请把两个插件都更新到最新版本。` }
    }
    return { ...base, state: 'ready', version: String(service.version ?? ''), detail: '' }
  }
  if (profile && existsSync(path.join(profile.dir, 'node_modules', entry.packageName, 'package.json'))) {
    return { ...base, state: 'installed', detail: '已安装但尚未加载：请完全退出 DSH（包括托盘图标）后重新打开。' }
  }
  return { ...base, state: 'missing', detail: `未安装。在对话中输入 /maa ext install ${entry.id} 安装。` }
}

/** The service of a ready companion, or a status explaining why it is not usable. */
export function extensionService(ctx, id) {
  const entry = findExtension(id)
  if (entry === null) throw new Error(`未知的辅助插件：${id}`)
  const status = extensionStatus(ctx, entry)
  return { entry, status, service: status.state === 'ready' ? safeGet(ctx, entry.service) : null }
}

const STATE_LABEL = { ready: '已启用', incompatible: '版本不匹配', installed: '已安装，待重启 DSH', missing: '未安装' }

export function describeExtensions(ctx) {
  const profile = activeProfile(ctx)
  const lines = ['dsh-maa-cli 辅助插件：']
  for (const entry of EXTENSIONS) {
    const status = extensionStatus(ctx, entry, profile)
    lines.push('', `- ${entry.id}｜${entry.packageName}｜${STATE_LABEL[status.state]}${status.version ? `（${status.version}）` : ''}`)
    lines.push(`  ${entry.title}：${entry.description}`)
    if (status.detail) lines.push(`  ${status.detail}`)
  }
  lines.push('', '安装：/maa ext install <id>（会先显示要执行的操作，确认后才安装）')
  return lines.join('\n')
}

export function previewInstall(ctx, id, env = process.env) {
  const entry = requireEntry(id)
  const profile = activeProfile(ctx)
  const spec = extensionInstallSpec(entry, env)
  const status = extensionStatus(ctx, entry, profile)
  if (status.state === 'ready') return { kind: 'success', text: `${entry.packageName} 已安装并启用，无需重复安装。` }
  const manual = `dsh plugin --profile ${profile?.name ?? '<配置名>'} add ${spec}`
  if (profile === null || profile.packageManager === null) {
    return { kind: 'error', text: `无法确认当前 DSH 配置或它的包管理器，不会自动安装。请手动运行：\n${manual}\n然后把 ${entry.packageName} 加入该配置 package.json 的 dsh.profile.bundles，再完全退出并重新打开 DSH。` }
  }
  return {
    kind: 'success',
    text: [
      `将安装辅助插件 ${entry.packageName}（${entry.title}）：`,
      `- 安装来源：${spec}`,
      `- 安装到 DSH 配置「${profile.name}」：${profile.dir}`,
      `- 下载体积：${entry.size}`,
      `- 同时把它加入该配置的 dsh.profile.bundles，DSH 才会加载它`,
      `- 等同于手动运行：${manual}`,
      '',
      `确认安装请输入：/maa ext install ${entry.id} confirm`,
    ].join('\n'),
  }
}

export async function installExtension(ctx, id, options = {}) {
  const entry = requireEntry(id)
  const env = options.env ?? process.env
  const profile = activeProfile(ctx)
  if (profile === null || profile.packageManager === null) return previewInstall(ctx, id, env)
  const spec = extensionInstallSpec(entry, env)
  if (!SAFE_SPEC.test(spec)) return { kind: 'error', text: `安装来源格式不安全，已拒绝：${spec}` }
  const manifestFile = path.join(profile.dir, 'package.json')
  if (!existsSync(manifestFile)) return { kind: 'error', text: `当前 DSH 配置目录里没有 package.json：${profile.dir}` }

  const result = await runPackageManager(profile, ['add', spec], { ...options, timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS })
  const installed = existsSync(path.join(profile.dir, 'node_modules', entry.packageName, 'package.json'))
  if (result.exitCode !== 0 || !installed) {
    return { kind: 'error', text: `安装 ${entry.packageName} 失败（退出码 ${result.exitCode}${result.timedOut ? '，超时' : ''}）：\n${result.output || '没有输出'}` }
  }
  let bundleAdded
  try {
    bundleAdded = await addProfileBundle(manifestFile, entry.packageName)
  } catch (error) {
    return { kind: 'error', text: `${entry.packageName} 已安装，但写入 dsh.profile.bundles 失败：${error instanceof Error ? error.message : String(error)}。请手动把它加入 ${manifestFile} 的 dsh.profile.bundles。` }
  }
  return {
    kind: 'success',
    text: [
      `已安装辅助插件 ${entry.packageName}${bundleAdded ? '，并加入当前配置的 dsh.profile.bundles' : '（dsh.profile.bundles 中已存在）'}。`,
      'DSH 通常会在几秒内自动加载新插件；若 /maa ext 仍显示「已安装，待重启 DSH」，请完全退出 DSH（包括托盘图标）后重新打开。',
    ].join('\n'),
  }
}

function requireEntry(id) {
  const entry = findExtension(id)
  if (entry === null) throw new Error(`未知的辅助插件：${id}。可用：${EXTENSIONS.map(item => item.id).join('、')}`)
  return entry
}

async function addProfileBundle(manifestFile, packageName) {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles.filter(item => typeof item === 'string') : []
  if (bundles.includes(packageName)) return false
  manifest.dsh.profile.bundles = [...bundles, packageName]
  const temporary = `${manifestFile}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rename(temporary, manifestFile)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return true
}

// Runs the host's own package manager (as published in profileContext) in the
// profile directory. Arguments are passed as an array; a .cmd shim goes
// through cmd.exe with every argument quoted, since Node refuses to spawn it
// directly.
function runPackageManager(profile, extraArgs, options) {
  const spawnImpl = options.spawnImpl ?? spawn
  const { command, args, env } = profile.packageManager
  const argv = [...args, ...extraArgs]
  const childEnv = { ...process.env, ...env }
  const shim = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)
  const child = shim
    ? spawnImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...argv].map(quoteCmd).join(' ')}"`], { cwd: profile.dir, env: childEnv, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnImpl(command, argv, { cwd: profile.dir, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise(resolve => {
    let output = ''
    let timedOut = false
    const keep = chunk => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_BYTES) }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch {} }, options.timeoutMs)
    const onAbort = () => { try { child.kill() } catch {} }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = exitCode => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode, timedOut, output: output.trim() })
    }
    child.on('error', error => { output += `\n${error.message}`; finish(-1) })
    child.on('close', code => finish(typeof code === 'number' ? code : -1))
  })
}

function quoteCmd(value) {
  return /^[A-Za-z0-9@._/:+~^=\\-]+$/u.test(value) ? value : `"${String(value).replace(/"/gu, '""')}"`
}
