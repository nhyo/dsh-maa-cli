import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Self-contained maa-cli runtime.
 *
 * The plugin must work on a machine that has never seen MAA. Instead of asking
 * the user to install MAA by hand, the plugin keeps its own copy of maa-cli and
 * of MaaCore under one directory and points maa-cli at it with the four
 * `MAA_*_DIR` variables the tool itself honours. That keeps the bootstrap
 * isolated from any MAA installation the user may already have, and makes the
 * runtime removable by deleting a single folder.
 */

export const RUNTIME_DIR_ENV = 'DSH_MAA_CLI_RUNTIME_DIR'
export const ASSET_URL_ENV = 'DSH_MAA_CLI_ASSET_URL'
export const RELEASE_API_URL = 'https://api.github.com/repos/MaaAssistantArknights/maa-cli/releases/latest'

const TARGETS = Object.freeze({
  win32: { x64: ['x86_64-pc-windows-msvc', '.zip'], arm64: ['aarch64-pc-windows-msvc', '.zip'] },
  linux: { x64: ['x86_64-unknown-linux-gnu', '.tar.gz'], arm64: ['aarch64-unknown-linux-gnu', '.tar.gz'] },
  darwin: { x64: ['x86_64-apple-darwin', '.tar.gz'], arm64: ['aarch64-apple-darwin', '.tar.gz'] },
})

const EXECUTABLE_CANDIDATES = Object.freeze(['maa.exe', 'maa-cli.exe', 'maa', 'maa-cli'])

export function runtimeRoot(env = process.env) {
  const override = (env[RUNTIME_DIR_ENV] ?? '').trim()
  if (override !== '') return path.resolve(override)
  return path.join(os.homedir(), '.dsh', 'maa-cli', 'runtime')
}

export function runtimeExecutableName(platform = process.platform) {
  // The published archives ship the binary as `maa.exe`/`maa`; older builds
  // and the winget package use `maa-cli`.
  return platform === 'win32' ? 'maa.exe' : 'maa'
}

export function runtimeLayout(env = process.env) {
  const root = runtimeRoot(env)
  const bin = path.join(root, 'bin')
  return {
    root,
    bin,
    executable: path.join(bin, runtimeExecutableName()),
    data: path.join(root, 'data'),
    state: path.join(root, 'state'),
    cache: path.join(root, 'cache'),
    config: path.join(root, 'config'),
    downloads: path.join(root, 'downloads'),
    manifest: path.join(root, 'runtime.json'),
  }
}

/** The archive layout is not guaranteed, so accept any known binary name. */
export async function findRuntimeExecutable(binDirectory) {
  for (const name of EXECUTABLE_CANDIDATES) {
    const candidate = path.join(binDirectory, name)
    if (await exists(candidate)) return candidate
  }
  return ''
}

/**
 * The four variables are exactly what `maa-dirs` resolves before falling back
 * to the platform defaults, so every maa-cli child process sees the runtime
 * directories only: data/lib holds MaaCore, data/resource holds resources,
 * config holds `profiles/default.toml`.
 */
export function runtimeEnvironment(layout = runtimeLayout()) {
  return {
    MAA_DATA_DIR: layout.data,
    MAA_STATE_DIR: layout.state,
    MAA_CACHE_DIR: layout.cache,
    MAA_CONFIG_DIR: layout.config,
  }
}

export async function inspectRuntime(env = process.env) {
  const layout = runtimeLayout(env)
  const executablePath = await findRuntimeExecutable(layout.bin)
  const core = await exists(path.join(layout.data, 'lib', process.platform === 'win32' ? 'MaaCore.dll' : 'libMaaCore.so'))
  const resource = await exists(path.join(layout.data, 'resource'))
  const manifest = await readManifest(layout)
  return {
    layout,
    executablePath,
    executable: executablePath !== '',
    core,
    resource,
    installed: executablePath !== '' && core && resource,
    manifest,
  }
}

export async function readManifest(layout = runtimeLayout()) {
  try {
    return JSON.parse(await readFile(layout.manifest, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Merge a few fields into the runtime manifest. Used when later steps learn
 * something the bootstrap could not know up front (for example the adb path
 * that was written into the generated profile), so `status` keeps telling the
 * truth instead of showing values captured seconds earlier.
 */
export async function updateManifest(layout, patch) {
  const current = await readManifest(layout)
  if (current === null) return null
  const merged = { ...current, ...patch }
  try {
    await writeFile(layout.manifest, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    return merged
  } catch {
    return null
  }
}

/**
 * Pick the archive for this machine. Release assets are named
 * `maa_cli-<version>-<target-triple>.<ext>`; the `-winget` variants are
 * packaging manifests rather than the binary, so they are skipped.
 */
export function selectAsset(assets, options = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const target = TARGETS[platform]?.[arch]
  if (target === undefined) return null
  const [triple, extension] = target
  const candidates = (Array.isArray(assets) ? assets : []).filter(asset => {
    const name = String(asset?.name ?? '')
    return name.includes(triple) && name.endsWith(extension) && !name.includes('winget')
  })
  if (candidates.length === 0) return null
  const asset = candidates[0]
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: Number(asset.size ?? 0),
    sha256: String(asset.digest ?? '').replace(/^sha256:/i, ''),
    version: options.version ?? '',
  }
}

export async function fetchLatestAsset(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime has no fetch() to download maa-cli')
  const response = await fetchImpl(options.apiUrl ?? RELEASE_API_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-maa-cli' },
  })
  if (!response.ok) throw new Error(`GitHub release lookup failed with HTTP ${response.status}`)
  const release = await response.json()
  const asset = selectAsset(release.assets, { ...options, version: release.tag_name ?? '' })
  if (asset === null) {
    throw new Error(`maa-cli ${release.tag_name ?? ''} has no build for ${process.platform}/${process.arch}`)
  }
  return asset
}

export async function downloadFile(url, destination, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`)
  if (response.body === null) throw new Error('Download returned an empty body')

  await mkdir(path.dirname(destination), { recursive: true })
  const hash = createHash('sha256')
  const chunks = []
  for await (const chunk of response.body) {
    chunks.push(chunk)
    hash.update(chunk)
  }
  const buffer = Buffer.concat(chunks)
  await writeFile(destination, buffer)
  return { path: destination, bytes: buffer.length, sha256: hash.digest('hex') }
}

/**
 * `tar` ships with Windows 10+, macOS and every mainstream Linux distribution,
 * and libarchive reads zip as well as tar, so one command covers both archive
 * formats without an npm dependency.
 */
export async function extractArchive(archive, destination, options = {}) {
  const tarPath = options.tarPath ?? 'tar'
  await mkdir(destination, { recursive: true })
  const result = await runProcess(tarPath, ['-xf', archive, '-C', destination], { timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal })
  if (result.exitCode !== 0) {
    throw new Error(`Failed to extract ${path.basename(archive)}: ${result.stderr.trim() || `tar exited with ${result.exitCode}`}`)
  }
  return destination
}

export function defaultProfileToml(options = {}) {
  const adbPath = options.adbPath ?? ''
  const address = options.address ?? '127.0.0.1:16384'
  const config = options.config ?? 'MuMuEmulator12'
  const lines = ['[connection]']
  if (adbPath === '') {
    lines.push('# No adb detected: fill in the full path of the emulator adb.exe below', '# adb_path = ""')
  } else {
    lines.push(`adb_path = ${JSON.stringify(adbPath)}`)
  }
  lines.push(
    `address = ${JSON.stringify(address)}`,
    `config = ${JSON.stringify(config)}`,
    '',
    '[instance_options]',
    'touch_mode = "MiniTouch"',
    'adb_lite_enabled = false',
    'kill_adb_on_exit = false',
    '',
  )
  return lines.join('\n')
}

export async function writeDefaultProfile(layout = runtimeLayout(), options = {}) {
  const profiles = path.join(layout.config, 'profiles')
  await mkdir(profiles, { recursive: true })
  const file = path.join(profiles, 'default.toml')
  await writeFile(file, defaultProfileToml(options), 'utf8')
  await updateManifest(layout, { adbPath: options.adbPath ?? '', profile: file })
  return file
}

/** Find an adb binary without guessing a single vendor layout. */
export async function detectAdbPath(env = process.env) {
  const explicit = (env.DSH_MAA_CLI_ADB_PATH ?? '').trim()
  if (explicit !== '') return (await exists(explicit)) ? explicit : ''

  const candidates = []
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const root = (env[key] ?? '').trim()
    if (root !== '') candidates.push(path.join(root, 'platform-tools', 'adb.exe'))
  }
  const programFilesRoots = []
  for (const key of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    const value = (env[key] ?? '').trim()
    if (value === '') continue
    for (const root of value.split(';')) {
      const trimmed = root.trim()
      if (trimmed !== '' && !programFilesRoots.includes(trimmed)) programFilesRoots.push(trimmed)
    }
  }
  // Emulators installed on another drive are common, so also try the standard
  // program directories of every fixed drive that exists.
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
    if (!(await exists(`${drive}:\\`))) continue
    for (const folder of ['Program Files', 'Program Files (x86)']) {
      programFilesRoots.push(`${drive}:\\${folder}`)
    }
  }
  for (const root of programFilesRoots) {
    candidates.push(path.join(root, 'Netease', 'MuMu', 'nx_main', 'adb.exe'))
    candidates.push(path.join(root, 'Netease', 'MuMu', 'emulator', 'nemu', 'vmonitor', 'bin', 'adb_server.exe'))
    candidates.push(path.join(root, 'LDPlayer', 'LDPlayer9', 'adb.exe'))
    candidates.push(path.join(root, 'BlueStacks_nxt', 'HD-Adb.exe'))
  }
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (directory.trim() !== '') candidates.push(path.join(directory.trim(), 'adb.exe'))
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return ''
}

/**
 * Bootstrap: download maa-cli, then let maa-cli itself fetch the matching
 * MaaCore build and resources into the runtime directories. Each step is
 * idempotent so an interrupted download can simply be retried.
 */
export async function bootstrapRuntime(options = {}) {
  const env = options.env ?? process.env
  const layout = runtimeLayout(env)
  const steps = []
  const report = (id, detail) => {
    steps.push({ id, detail })
    options.onStep?.(id, detail)
  }

  const current = await inspectRuntime(env)
  if (current.installed && options.force !== true) {
    report('already-installed', `runtime ready: ${layout.root}`)
    return { layout, steps, installed: true, alreadyInstalled: true, manifest: current.manifest }
  }

  await mkdir(layout.downloads, { recursive: true })

  const assetUrl = options.assetUrl ?? env[ASSET_URL_ENV]
  const asset = options.asset ?? (assetUrl !== undefined && String(assetUrl).trim() !== ''
    ? { name: path.basename(new URL(assetUrl).pathname), url: assetUrl, sha256: '', size: 0, version: '' }
    : await fetchLatestAsset({ fetchImpl: options.fetchImpl }))
  report('resolve', `maa-cli ${asset.version || '(explicit URL)'} -> ${asset.name}`)

  const archive = path.join(layout.downloads, asset.name)
  if (!(await exists(archive))) {
    const download = await downloadFile(asset.url, archive, { fetchImpl: options.fetchImpl })
    report('download', `${asset.name}: ${formatBytes(download.bytes)}`)
    if (asset.sha256 !== '' && download.sha256 !== asset.sha256) {
      await rm(archive, { force: true })
      throw new Error(`maa-cli 下载校验失败：期望 ${asset.sha256}，实际 ${download.sha256}`)
    }
  } else {
    report('download', `${asset.name}: cached`)
  }

  await mkdir(layout.bin, { recursive: true })
  const extract = options.extract ?? extractArchive
  await extract(archive, layout.bin, { signal: options.signal })
  const cliPath = await findRuntimeExecutable(layout.bin)
  if (cliPath === '') {
    throw new Error(`archive contains no maa-cli binary (expected ${runtimeExecutableName()} or maa-cli): ${layout.bin}`)
  }
  report('extract', `maa-cli -> ${cliPath}`)

  const run = options.run
  if (typeof run !== 'function') throw new Error('bootstrapRuntime needs a run() implementation')
  const runtimeEnv = { ...env, ...runtimeEnvironment(layout) }

  // maa-cli installs MaaCore into `<MAA_DATA_DIR>/lib` and resources into
  // `<MAA_DATA_DIR>/resource`, so the whole runtime stays inside one folder.
  const installed = await run(['install', '--batch'], {
    cliPath,
    env: runtimeEnv,
    signal: options.signal,
    timeoutMs: options.installTimeoutMs ?? 60 * 60_000,
  })
  report('install', `maa-cli install exit ${installed.exitCode}`)
  if (installed.exitCode !== 0) {
    throw new Error(`maa-cli install 失败（退出码 ${installed.exitCode}）：${(installed.stderr || installed.stdout || '').slice(-800)}`)
  }

  const adbPath = options.adbPath ?? (await detectAdbPath(env))
  const profile = await writeDefaultProfile(layout, {
    adbPath,
    address: options.address,
    config: options.emulatorConfig,
  })
  report('profile', `default.toml -> ${profile}${adbPath === '' ? ' (no adb detected, fill adb_path manually)' : ''}`)

  const after = await inspectRuntime(env)
  const manifest = {
    version: 1,
    maaCliVersion: asset.version || installed.stdout.match(/v?\d+\.\d+\.\d+/)?.[0] || '',
    asset: asset.name,
    installedAt: new Date().toISOString(),
    layout: { root: layout.root, executable: cliPath, data: layout.data, config: layout.config },
    adbPath,
  }
  await writeFile(layout.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // `maa-cli install` keeps the whole MaaCore archive in its download cache
  // (hundreds of MB). Once the install succeeded the archive is redundant:
  // a later `update` downloads again anyway.
  let reclaimed = 0
  if (options.keepCaches !== true) {
    reclaimed = await pruneInstallCaches(layout)
    if (reclaimed > 0) report('prune', `已清理安装缓存：${formatBytes(reclaimed)}`)
  }
  report('done', after.installed ? `运行时已就绪：${layout.root}` : '运行时仍不完整，请查看 maa-cli install 输出')

  return { layout, steps, installed: after.installed, alreadyInstalled: false, manifest, core: after.core, resource: after.resource, reclaimed }
}

/** Remove the downloaded MaaCore archives maa-cli keeps after installing. */
export async function pruneInstallCaches(layout = runtimeLayout()) {
  let reclaimed = 0
  let entries = []
  try {
    entries = await readdir(layout.cache, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/^MAA-.*\.zip$/i.test(entry.name) && !/^MAA-.*\.tar\.gz$/i.test(entry.name)) continue
    const file = path.join(layout.cache, entry.name)
    const size = await fileSize(file)
    try {
      await rm(file, { force: true })
      reclaimed += size
    } catch {
      // A locked cache file only costs disk space, never correctness.
    }
  }
  return reclaimed
}

export async function updateRuntime(options = {}) {
  const env = options.env ?? process.env
  const layout = runtimeLayout(env)
  const status = await inspectRuntime(env)
  if (!status.installed) throw new Error('运行时尚未安装，请先执行 maa_runtime 的 install')
  const result = await options.run(['update', '--batch'], {
    cliPath: status.executablePath,
    env: { ...env, ...runtimeEnvironment(layout) },
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
  })
  return { layout, result }
}

export function formatRuntimeReport(status) {
  const lines = [
    `运行时目录：${status.layout.root}`,
    `maa-cli：${status.executablePath || '未安装'}`,
    `MaaCore：${status.core ? '已安装' : '未安装'}（${path.join(status.layout.data, 'lib')}）`,
    `资源：${status.resource ? '已安装' : '未安装'}（${path.join(status.layout.data, 'resource')}）`,
  ]
  if (status.manifest?.maaCliVersion) lines.push(`版本：${status.manifest.maaCliVersion}`)
  if (status.manifest?.installedAt) lines.push(`安装时间：${status.manifest.installedAt}`)
  lines.push(status.installed ? '状态：可用（无需系统安装 MAA）' : '状态：未就绪 —— 执行 maa_runtime install 自动下载（约 250–450 MB）')
  return lines.join('\n')
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export async function fileSize(target) {
  try {
    return (await stat(target)).size
  } catch {
    return 0
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000)
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: typeof code === 'number' ? code : -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}
