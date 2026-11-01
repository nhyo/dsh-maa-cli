import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  bootstrapRuntime,
  defaultProfileToml,
  downloadFile,
  formatBytes,
  inspectRuntime,
  maybeAutoUpdateRuntime,
  runtimeEnvironment,
  runtimeLayout,
  runtimeRoot,
  selectAsset,
  updateRuntime,
  pruneInstallCaches,
  exists,
} from '../src/runtime/runtime.js'

async function tempRoot(prefix = 'dsh-maa-runtime-') {
  return await mkdtemp(path.join(os.tmpdir(), prefix))
}

test('derives every runtime directory from one root', async () => {
  const root = await tempRoot()
  const env = { DSH_MAA_CLI_RUNTIME_DIR: root }
  const layout = runtimeLayout(env)
  assert.equal(runtimeRoot(env), path.resolve(root))
  assert.equal(layout.executable, path.join(root, 'bin', process.platform === 'win32' ? 'maa.exe' : 'maa'))
  assert.equal(layout.data, path.join(root, 'data'))
  assert.equal(layout.config, path.join(root, 'config'))
  assert.equal(layout.manifest, path.join(root, 'runtime.json'))
})

test('maps the runtime onto the four MAA_*_DIR variables maa-cli honours', async () => {
  const layout = runtimeLayout({ DSH_MAA_CLI_RUNTIME_DIR: await tempRoot() })
  assert.deepEqual(runtimeEnvironment(layout), {
    MAA_DATA_DIR: layout.data,
    MAA_STATE_DIR: layout.state,
    MAA_CACHE_DIR: layout.cache,
    MAA_CONFIG_DIR: layout.config,
  })
})

test('selects the platform archive and ignores winget manifests', () => {
  const assets = [
    { name: 'maa_cli-v0.7.7-aarch64-apple-darwin.tar.gz', browser_download_url: 'u1', size: 1, digest: 'sha256:aa' },
    { name: 'maa_cli-v0.7.7-x86_64-pc-windows-msvc-winget.zip', browser_download_url: 'u2', size: 2, digest: 'sha256:bb' },
    { name: 'maa_cli-v0.7.7-x86_64-pc-windows-msvc.zip', browser_download_url: 'u3', size: 3_620_660, digest: 'sha256:cc' },
  ]
  const windows = selectAsset(assets, { platform: 'win32', arch: 'x64', version: 'v0.7.7' })
  assert.equal(windows.name, 'maa_cli-v0.7.7-x86_64-pc-windows-msvc.zip')
  assert.equal(windows.url, 'u3')
  assert.equal(windows.sha256, 'cc')
  assert.equal(windows.version, 'v0.7.7')
  assert.equal(selectAsset(assets, { platform: 'linux', arch: 'x64' }), null)
  assert.equal(selectAsset(assets, { platform: 'win32', arch: 'ia32' }), null)
})

test('writes a default.toml that matches the maa-cli profile schema', async () => {
  const withAdb = defaultProfileToml({ adbPath: String.raw`C:\emu\adb.exe` })
  assert.match(withAdb, /^\[connection\]\nadb_path = "C:\\\\emu\\\\adb\.exe"/)
  assert.match(withAdb, /address = "127\.0\.0\.1:16384"/)
  assert.match(withAdb, /config = "MuMuEmulator12"/)
  assert.match(withAdb, /\[instance_options\]\ntouch_mode = "MiniTouch"\nadb_lite_enabled = false\nkill_adb_on_exit = false/)

  const withoutAdb = defaultProfileToml({})
  assert.match(withoutAdb, /# adb_path = ""/)
})

test('formats byte counts for progress messages', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(3_620_660), '3.5 MB')
  assert.equal(formatBytes(1024 ** 3), '1.0 GB')
})

test('downloads a file and reports its sha256', async () => {
  const root = await tempRoot()
  const destination = path.join(root, 'maa_cli.zip')
  const payload = Buffer.from('maa-cli-payload')
  const fetchImpl = async () => ({
    ok: true,
    body: (async function* () {
      yield payload.subarray(0, 5)
      yield payload.subarray(5)
    })(),
  })
  const result = await downloadFile('https://example.invalid/maa.zip', destination, { fetchImpl })
  assert.equal(result.bytes, payload.length)
  assert.equal(result.sha256, createHash('sha256').update(payload).digest('hex'))
  assert.equal(await readFile(destination, 'utf8'), 'maa-cli-payload')
})

test('reports an empty runtime as not installed', async () => {
  const status = await inspectRuntime({ DSH_MAA_CLI_RUNTIME_DIR: await tempRoot() })
  assert.equal(status.installed, false)
  assert.equal(status.executable, false)
  assert.equal(status.manifest, null)
})

test('bootstrap short-circuits when the runtime is already complete', async () => {
  const root = await tempRoot()
  const env = { DSH_MAA_CLI_RUNTIME_DIR: root }
  const layout = runtimeLayout(env)
  await mkdir(layout.bin, { recursive: true })
  await mkdir(path.join(layout.data, 'lib'), { recursive: true })
  await mkdir(path.join(layout.data, 'resource'), { recursive: true })
  await writeFile(layout.executable, '')
  await writeFile(path.join(layout.data, 'lib', process.platform === 'win32' ? 'MaaCore.dll' : 'libMaaCore.so'), '')

  let called = false
  const result = await bootstrapRuntime({ env, run: async () => { called = true } })
  assert.equal(result.alreadyInstalled, true)
  assert.equal(called, false)
  assert.equal(result.steps[0].id, 'already-installed')
})

test('bootstrap downloads, installs into the runtime, and writes a profile', async () => {
  const root = await tempRoot()
  const env = { DSH_MAA_CLI_RUNTIME_DIR: root, DSH_MAA_CLI_ADB_PATH: '' }
  const layout = runtimeLayout(env)
  const payload = Buffer.from('zip-bytes')
  const sha = createHash('sha256').update(payload).digest('hex')
  const asset = { name: 'maa_cli-v0.7.7-x86_64-pc-windows-msvc.zip', url: 'https://example.invalid/maa.zip', sha256: sha, size: payload.length, version: 'v0.7.7' }
  const fetchImpl = async () => ({
    ok: true,
    body: (async function* () { yield payload })(),
  })
  const calls = []
  const run = async (args, options) => {
    calls.push({ args, options })
    await mkdir(path.join(layout.data, 'lib'), { recursive: true })
    await mkdir(path.join(layout.data, 'resource'), { recursive: true })
    await writeFile(path.join(layout.data, 'lib', process.platform === 'win32' ? 'MaaCore.dll' : 'libMaaCore.so'), '')
    return { exitCode: 0, stdout: 'MaaCore v6.20.1', stderr: '' }
  }
  const steps = []
  const result = await bootstrapRuntime({
    env,
    asset,
    fetchImpl,
    run,
    onStep: (id, detail) => steps.push({ id, detail }),
    extract: async (_archive, destination) => {
      await mkdir(path.join(destination), { recursive: true })
      await writeFile(layout.executable, '')
    },
  })

  assert.equal(result.installed, true)
  assert.equal(result.alreadyInstalled, false)
  assert.deepEqual(steps.map(step => step.id), ['resolve', 'download', 'extract', 'install', 'profile', 'done'])
  assert.deepEqual(calls[0].args, ['install', '--batch'])
  assert.equal(calls[0].options.cliPath, layout.executable)
  assert.equal(calls[0].options.env.MAA_DATA_DIR, layout.data)
  assert.equal(calls[0].options.env.MAA_CONFIG_DIR, layout.config)

  const profile = await readFile(path.join(layout.config, 'profiles', 'default.toml'), 'utf8')
  assert.match(profile, /^\[connection\]/)
  const manifest = JSON.parse(await readFile(layout.manifest, 'utf8'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.maaCliVersion, 'v0.7.7')
  assert.equal(manifest.asset, asset.name)
})

test('bootstrap rejects a corrupt download', async () => {
  const env = { DSH_MAA_CLI_RUNTIME_DIR: await tempRoot() }
  const fetchImpl = async () => ({
    ok: true,
    body: (async function* () { yield Buffer.from('bad') })(),
  })
  await assert.rejects(bootstrapRuntime({
    env,
    asset: { name: 'maa.zip', url: 'https://example.invalid/maa.zip', sha256: 'deadbeef', size: 3, version: '' },
    fetchImpl,
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  }), /校验失败/)
})

test('bootstrap surfaces a failing maa-cli install', async () => {
  const env = { DSH_MAA_CLI_RUNTIME_DIR: await tempRoot() }
  const layout = runtimeLayout(env)
  const run = async () => ({ exitCode: 7, stdout: '', stderr: 'network unreachable' })
  await assert.rejects(bootstrapRuntime({
    env,
    asset: { name: 'maa.zip', url: 'https://example.invalid/maa.zip', sha256: '', size: 0, version: '' },
    fetchImpl: async () => ({ ok: true, body: (async function* () { yield Buffer.from('x') })() }),
    run,
    extract: async (_archive, destination) => {
      await mkdir(destination, { recursive: true })
      await writeFile(layout.executable, '')
    },
  }), /maa-cli install 失败（退出码 7）/)
})

test('update refuses to run without an installed runtime', async () => {
  await assert.rejects(
    updateRuntime({ env: { DSH_MAA_CLI_RUNTIME_DIR: await tempRoot() }, run: async () => ({ exitCode: 0 }) }),
    /尚未安装/,
  )
})

test('automatic update is throttled, serialized, and keeps the installed runtime on failure', async () => {
  const root = await tempRoot()
  const env = { DSH_MAA_CLI_RUNTIME_DIR: root }
  const layout = runtimeLayout(env)
  await mkdir(layout.bin, { recursive: true })
  await mkdir(path.join(layout.data, 'lib'), { recursive: true })
  await mkdir(path.join(layout.data, 'resource'), { recursive: true })
  await writeFile(layout.executable, '')
  const core = path.join(layout.data, 'lib', process.platform === 'win32' ? 'MaaCore.dll' : 'libMaaCore.so')
  await writeFile(core, 'old-core')
  await writeFile(layout.manifest, JSON.stringify({ version: 1, installedAt: '2026-10-01T00:00:00.000Z' }))
  const lib = path.join(layout.data, 'lib')
  await rename(lib, `${lib}.dsh-update-backup`)
  await mkdir(lib, { recursive: true })
  await writeFile(path.join(lib, 'partial-download'), 'partial')

  let calls = 0
  const failedRun = async args => {
    calls += 1
    assert.deepEqual(args, ['update', '--batch'])
    return { exitCode: 7, stdout: '', stderr: 'network unavailable' }
  }
  const now = Date.parse('2026-10-29T12:00:00Z')
  const [first, concurrent] = await Promise.all([
    maybeAutoUpdateRuntime({ env, run: failedRun, now }),
    maybeAutoUpdateRuntime({ env, run: failedRun, now }),
  ])
  assert.equal(calls, 1)
  assert.match(first.warning, /继续使用原版本/)
  assert.match(concurrent.warning, /继续使用原版本/)
  assert.equal(await readFile(core, 'utf8'), 'old-core')

  let notified = 0
  const onUpdateStart = async () => { notified += 1 }
  const throttled = await maybeAutoUpdateRuntime({ env, run: failedRun, now: now + 60_000, onUpdateStart })
  assert.equal(throttled.skipped, 'not-due')
  assert.equal(calls, 1)
  assert.equal(notified, 0, 'a skipped check does not announce an update')
  const manifest = JSON.parse(await readFile(layout.manifest, 'utf8'))
  assert.equal(manifest.lastAutoUpdateCheckAt, '2026-10-29T12:00:00.000Z')

  const success = await maybeAutoUpdateRuntime({
    env,
    run: async args => {
      calls += 1
      assert.deepEqual(args, ['update', '--batch'])
      await rm(path.join(layout.data, 'lib'), { recursive: true, force: true })
      await mkdir(path.join(layout.data, 'lib'), { recursive: true })
      await writeFile(core, 'new-core')
      assert.equal(notified, 1, 'the update is announced before maa-cli starts downloading')
      return { exitCode: 0, stdout: 'Already up to date', stderr: '' }
    },
    now: now + 2 * 24 * 60 * 60_000,
    onUpdateStart,
  })
  assert.equal(success.checked, true)
  assert.equal(success.warning, '')
  assert.equal(calls, 2)
  assert.equal(await readFile(core, 'utf8'), 'new-core')

  const busy = await maybeAutoUpdateRuntime({ env, run: failedRun, now: now + 4 * 24 * 60 * 60_000, allowed: false })
  assert.equal(busy.skipped, 'task-active')
  assert.equal(calls, 2)
})

test('prunes the MaaCore archive maa-cli leaves in its cache', async () => {
  const layout = runtimeLayout({ DSH_MAA_CLI_RUNTIME_DIR: await tempRoot() })
  await mkdir(layout.cache, { recursive: true })
  await writeFile(path.join(layout.cache, 'MAA-v6.20.1-win-x64.zip'), Buffer.alloc(2048, 1))
  await writeFile(path.join(layout.cache, 'tasks.json'), '{}')

  const reclaimed = await pruneInstallCaches(layout)

  assert.equal(reclaimed, 2048)
  assert.equal(await exists(path.join(layout.cache, 'MAA-v6.20.1-win-x64.zip')), false)
  assert.equal(await exists(path.join(layout.cache, 'tasks.json')), true)
})

test('keeps caches on request and reports how much was reclaimed', async () => {
  const root = await tempRoot()
  const env = { DSH_MAA_CLI_RUNTIME_DIR: root, DSH_MAA_CLI_ADB_PATH: '' }
  const layout = runtimeLayout(env)
  const payload = Buffer.from('zip-bytes')
  const asset = { name: 'maa_cli-v0.7.7-x86_64-pc-windows-msvc.zip', url: 'https://example.invalid/maa.zip', sha256: '', size: payload.length, version: 'v0.7.7' }
  const run = async () => {
    await mkdir(path.join(layout.data, 'lib'), { recursive: true })
    await mkdir(path.join(layout.data, 'resource'), { recursive: true })
    await writeFile(path.join(layout.data, 'lib', process.platform === 'win32' ? 'MaaCore.dll' : 'libMaaCore.so'), '')
    await mkdir(layout.cache, { recursive: true })
    await writeFile(path.join(layout.cache, 'MAA-v6.20.1-win-x64.zip'), Buffer.alloc(1024, 1))
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const options = {
    env,
    asset,
    fetchImpl: async () => ({ ok: true, body: (async function* () { yield payload })() }),
    run,
    extract: async (_archive, destination) => {
      await mkdir(destination, { recursive: true })
      await writeFile(layout.executable, '')
    },
  }

  const pruned = await bootstrapRuntime(options)
  assert.equal(pruned.reclaimed, 1024)
  assert.equal(await exists(path.join(layout.cache, 'MAA-v6.20.1-win-x64.zip')), false)

  const kept = await bootstrapRuntime({ ...options, force: true, keepCaches: true })
  assert.equal(kept.reclaimed, 0)
  assert.equal(await exists(path.join(layout.cache, 'MAA-v6.20.1-win-x64.zip')), true)
})
