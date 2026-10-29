import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  atomicRenameProbe,
  formatReport,
  muMuManagerCandidates,
  parseAddress,
  parseProfile,
  parseVersionOutput,
  runDoctor,
  summarizeChecks,
} from './doctor.js'

const RESPONSE = stdout => ({ command: 'maa-cli', exitCode: 0, terminationSignal: '', stdout, stderr: '' })

function stubRunMaa(directories) {
  return async args => {
    if (args[0] === 'version') return RESPONSE('maa-cli v0.7.7\nMaaCore v6.20.1')
    if (args[0] === 'dir') return RESPONSE(`${directories[args[1]] ?? ''}\n`)
    throw new Error(`unexpected maa-cli call: ${args.join(' ')}`)
  }
}

async function makeLayout() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-doctor-'))
  const layout = {
    root,
    library: path.join(root, 'library'),
    cache: path.join(root, 'cache'),
    hotUpdate: path.join(root, 'hot-update'),
    config: path.join(root, 'config'),
  }
  await mkdir(layout.library, { recursive: true })
  await mkdir(layout.cache, { recursive: true })
  await mkdir(path.join(layout.hotUpdate, '.git'), { recursive: true })
  await mkdir(path.join(layout.hotUpdate, 'resource', 'Official'), { recursive: true })
  await mkdir(path.join(layout.config, 'profiles'), { recursive: true })
  await writeFile(path.join(layout.library, 'MaaCore.dll'), '')
  layout.adb = path.join(root, 'sim', 'nx_main', 'adb.exe')
  await mkdir(path.dirname(layout.adb), { recursive: true })
  await writeFile(layout.adb, '')
  await writeFile(
    path.join(layout.config, 'profiles', 'default.toml'),
    `[connection]\nadb_path = "${layout.adb.replaceAll('\\', '\\\\')}"\naddress = "127.0.0.1:16384"\nconfig = "MuMuEmulator12"\n`,
    'utf8',
  )
  return layout
}

test('parses version, profile, and adb address', () => {
  assert.deepEqual(parseVersionOutput('maa-cli v0.7.7\nMaaCore v6.20.1'), { cli: '0.7.7', core: '6.20.1' })
  assert.deepEqual(parseVersionOutput('garbage'), { cli: '', core: '' })
  assert.deepEqual(parseVersionOutput(''), { cli: '', core: '' })

  const profile = parseProfile('[connection]\nadb_path = "X:\\\\Mock\\\\MuMu\\\\nx_main\\\\adb.exe"\naddress = "127.0.0.1:16384"\n')
  assert.equal(profile.adbPath, 'X:\\Mock\\MuMu\\nx_main\\adb.exe')
  assert.equal(profile.address, '127.0.0.1:16384')
  assert.equal(profile.config, '')
  assert.deepEqual(parseProfile(''), { adbPath: '', address: '', config: '' })

  assert.deepEqual(parseAddress('127.0.0.1:16384'), { host: '127.0.0.1', port: 16384 })
  assert.deepEqual(parseAddress('[::1]:5555'), { host: '::1', port: 5555 })
  assert.deepEqual(parseAddress(':5555'), { host: '127.0.0.1', port: 5555 })
  assert.equal(parseAddress(''), null)
  assert.equal(parseAddress('127.0.0.1'), null)
  assert.equal(parseAddress('127.0.0.1:99999'), null)
})

test('derives both MuMu manager locations from the adb path', () => {
  assert.deepEqual(muMuManagerCandidates('X:\\Mock\\MuMu\\nx_main\\adb.exe'), [
    'X:\\Mock\\MuMu\\nx_main\\MuMuManager.exe',
    'X:\\Mock\\MuMu\\MuMuManager.exe',
  ])
  assert.deepEqual(muMuManagerCandidates(''), [])
})

test('summarizes and formats checks', () => {
  const clean = summarizeChecks([{ id: 'a', title: 'A', status: 'ok', detail: '' }])
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.failed, [])
  assert.match(clean.headline, /全部通过/)

  const warned = summarizeChecks([
    { id: 'a', title: 'A', status: 'ok', detail: '' },
    { id: 'b', title: 'B', status: 'warn', detail: '' },
  ])
  assert.equal(warned.ok, true)
  assert.deepEqual(warned.warned, ['b'])
  assert.match(warned.headline, /警告/)

  const failed = summarizeChecks([
    { id: 'a', title: '缓存目录', status: 'fail', detail: '' },
    { id: 'b', title: 'B', status: 'warn', detail: '' },
  ])
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.failed, ['a'])
  assert.match(failed.headline, /缓存目录/)

  const text = formatReport({
    headline: '环境不可用',
    checks: [
      { id: 'a', title: '缓存目录', status: 'fail', detail: 'EXDEV', hint: '迁到未加密卷' },
      { id: 'b', title: 'B', status: 'ok', detail: 'fine', hint: '不应显示' },
    ],
  })
  assert.match(text, /\[FAIL\] 缓存目录: EXDEV/)
  assert.match(text, /-> 迁到未加密卷/)
  assert.doesNotMatch(text, /不应显示/)
})

test('atomic rename probe succeeds and leaves no residue', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-probe-'))
  try {
    const result = await atomicRenameProbe(directory)
    assert.deepEqual(result, { ok: true })
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('atomic rename probe reports the EFS-style failure code', async () => {
  const result = await atomicRenameProbe(path.join(os.tmpdir(), 'dsh-maa-doctor-missing', 'nested'))
  assert.equal(result.ok, false)
  assert.notEqual(result.code, '')
})

test('diagnoses a healthy layout without touching the game', async () => {
  const layout = await makeLayout()
  try {
    const report = await runDoctor({
      runMaa: stubRunMaa({ library: layout.library, cache: layout.cache, 'hot-update': layout.hotUpdate, config: layout.config }),
      probe: async () => ({ ok: true }),
      isPortOpen: async () => true,
    })
    assert.equal(report.ok, true)
    assert.deepEqual(report.failed, [])
    assert.deepEqual(report.warned, ['mumu'])
    const cacheCheck = report.checks.find(item => item.id === 'cache')
    assert.equal(cacheCheck.status, 'ok')
    assert.equal(report.checks.find(item => item.id === 'port').status, 'ok')
    assert.equal(report.checks.find(item => item.id === 'redirect').status, 'ok')
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

test('flags a cache directory that cannot rename atomically', async () => {
  const layout = await makeLayout()
  try {
    const report = await runDoctor({
      runMaa: stubRunMaa({ library: layout.library, cache: layout.cache, 'hot-update': layout.hotUpdate, config: layout.config }),
      probe: async () => ({ ok: false, code: 'EXDEV', message: 'cross-device link not permitted' }),
      isPortOpen: async () => false,
    })
    assert.equal(report.ok, false)
    assert.ok(report.failed.includes('cache'))
    const cacheCheck = report.checks.find(item => item.id === 'cache')
    assert.equal(cacheCheck.status, 'fail')
    assert.match(cacheCheck.detail, /EXDEV/)
    assert.match(cacheCheck.hint, /junction|EFS|加密/)
    assert.equal(report.checks.find(item => item.id === 'port').status, 'fail')
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

test('degrades to warnings when maa-cli cannot resolve directories', async () => {
  const layout = await makeLayout()
  try {
    const report = await runDoctor({
      runMaa: stubRunMaa({}),
      probe: async () => ({ ok: true }),
      isPortOpen: async () => true,
    })
    assert.equal(report.ok, false)
    assert.ok(report.failed.includes('cache'))
    assert.ok(report.warned.includes('hot-update'))
    assert.ok(report.warned.includes('profile'))
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

test('resolves AppData directories through the packaged LocalCache redirect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-doctor-redirect-'))
  const env = { LOCALAPPDATA: path.join(root, 'Local'), APPDATA: path.join(root, 'Roaming') }
  const localCache = path.join(env.LOCALAPPDATA, 'Packages', 'Vendor.App_1', 'LocalCache', 'Local')
  const muMu = path.join(localCache, 'loong', 'maa')
  const real = {
    library: path.join(root, 'library'),
    cache: path.join(muMu, 'cache'),
    config: path.join(muMu, 'config'),
    'hot-update': path.join(muMu, 'hot-update'),
  }
  const literal = {
    library: real.library,
    cache: path.join(env.LOCALAPPDATA, 'loong', 'maa', 'cache'),
    config: path.join(env.LOCALAPPDATA, 'loong', 'maa', 'config'),
    'hot-update': path.join(env.LOCALAPPDATA, 'loong', 'maa', 'hot-update'),
  }
  try {
    await mkdir(real.library, { recursive: true })
    await writeFile(path.join(real.library, 'MaaCore.dll'), '')
    await mkdir(real.cache, { recursive: true })
    await mkdir(path.join(real.config, 'profiles'), { recursive: true })
    await mkdir(path.join(real['hot-update'], '.git'), { recursive: true })
    await mkdir(path.join(real['hot-update'], 'resource', 'Official'), { recursive: true })
    const adb = path.join(root, 'sim', 'nx_main', 'adb.exe')
    await mkdir(path.dirname(adb), { recursive: true })
    await writeFile(adb, '')
    await writeFile(
      path.join(real.config, 'profiles', 'default.toml'),
      `[connection]\nadb_path = "${adb.replaceAll('\\', '\\\\')}"\naddress = "127.0.0.1:16384"\nconfig = "MuMuEmulator12"\n`,
      'utf8',
    )

    const report = await runDoctor({
      runMaa: stubRunMaa(literal),
      env,
      probe: async () => ({ ok: true }),
      isPortOpen: async () => true,
    })
    const redirect = report.checks.find(item => item.id === 'redirect')
    assert.equal(redirect.status, 'warn')
    assert.match(redirect.detail, /LocalCache/)
    assert.equal(report.checks.find(item => item.id === 'cache').status, 'ok')
    assert.equal(report.checks.find(item => item.id === 'profile').status, 'ok')
    assert.equal(report.checks.find(item => item.id === 'hot-update').status, 'ok')
    assert.equal(report.failed.includes('cache'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
