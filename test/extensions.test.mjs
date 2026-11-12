import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Companion plugins: registry, status, the two-step install, the
// `maa_video_lineup` tool and the Box comparison. The companion itself is a
// fake object implementing service API v2; the real one lives in its own repo.
const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_MAA = path.join(here, 'fixtures', 'fake-maa.mjs')
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-ext-'))
const fakeRoot = path.join(root, 'maa')
const resourceDir = path.join(fakeRoot, 'resource')
const stateDir = path.join(root, 'state')
await mkdir(resourceDir, { recursive: true })
await mkdir(stateDir, { recursive: true })
let wrapper
if (process.platform === 'win32') {
  wrapper = path.join(root, 'fake-maa.cmd')
  await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${FAKE_MAA}" %*\r\n`)
} else {
  wrapper = path.join(root, 'fake-maa')
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_MAA}" "$@"\n`)
  await chmod(wrapper, 0o755)
}
Object.assign(process.env, { DSH_MAA_CLI_PATH: wrapper, FAKE_MAA_ROOT: fakeRoot, DSH_MAA_CLI_STATE_DIR: stateDir })
test.after(() => rm(root, { recursive: true, force: true }))

await writeFile(path.join(resourceDir, 'battle_data.json'), JSON.stringify({ chars: {
  char_1: { name: '维什戴尔' }, char_2: { name: '结城理' }, char_3: { name: '白面鸮' }, char_4: { name: '冻河' }, char_5: { name: '圣聆初雪' },
} }))
await writeFile(path.join(stateDir, 'operator-box.json'), JSON.stringify({ version: 1, scannedAt: new Date().toISOString(), operators: [
  { id: 'char_1', name: '维什戴尔', rarity: 6, elite: 2, level: 90, potential: 1 },
  { id: 'char_2', name: '结城理', rarity: 6, elite: 2, level: 90, potential: 1 },
  { id: 'char_3', name: '白面鸮', rarity: 5, elite: 2, level: 50, potential: 1 },
  { id: 'char_4', name: '冻河', rarity: 6, elite: 2, level: 90, potential: 1 },
] }))

const { apply } = await import('../src/index.js')
const { parseLocalMaaCommand } = await import('../src/commands/local-command.js')
const { activeProfile, extensionStatus, installExtension } = await import('../src/extensions/host.js')
const { EXTENSIONS, extensionInstallSpec, findExtension } = await import('../src/extensions/registry.js')
const { evaluateVideoLineup } = await import('../src/extensions/video-lineup.js')

const coverocr = findExtension('coverocr')

function hostContext(services = {}) {
  const tools = []
  const commands = []
  const ctx = {
    tools: { register: tool => tools.push(tool) },
    commands: { register: command => commands.push(command) },
    get: name => services[name],
  }
  apply(ctx)
  return { ctx, tool: name => tools.find(item => item.name === name), command: name => commands.find(item => item.name === name) }
}

async function profileDir(name) {
  const dir = path.join(root, 'profiles', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'dsh-maa-cli': '1.1.0' }, dsh: { profile: { bundles: ['dsh-maa-cli'] } } }, null, 2))
  return dir
}

function profileContext(dir, packageManager = { command: 'pnpm', args: [], env: {} }) {
  return { name: 'desktop', dir, packageManager }
}

const exec = () => ({ agent: { id: 'a', session: {} }, signal: AbortSignal.timeout(10_000), concludeTurn() {} })

test('the registry lists coverocr with a versioned service and an overridable install spec', () => {
  assert.ok(EXTENSIONS.length >= 1)
  assert.equal(coverocr.packageName, 'dsh-maa-coverocr')
  assert.equal(coverocr.service, 'maaCoverocr')
  assert.equal(findExtension('dsh-maa-coverocr'), coverocr)
  assert.equal(extensionInstallSpec(coverocr, {}), 'dsh-maa-coverocr')
  assert.equal(extensionInstallSpec(coverocr, { DSH_MAA_COVEROCR_SPEC: 'link:E:/DESK/dsh-maa-coverocr' }), 'link:E:/DESK/dsh-maa-coverocr')
})

test('/maa ext commands parse into list and a one-step install', () => {
  assert.deepEqual(parseLocalMaaCommand('ext'), { kind: 'ext-list' })
  assert.deepEqual(parseLocalMaaCommand('辅助插件'), { kind: 'ext-list' })
  assert.deepEqual(parseLocalMaaCommand('ext install coverocr'), { kind: 'ext-install', id: 'coverocr' })
  // The old two-step form still works and installs the same way.
  assert.deepEqual(parseLocalMaaCommand('ext install CoverOCR confirm'), { kind: 'ext-install', id: 'coverocr' })
})

test('status distinguishes ready, incompatible, installed-not-loaded and missing', async () => {
  const dir = await profileDir('status')
  const profile = activeProfile({ get: () => profileContext(dir) })
  assert.equal(extensionStatus({ get: () => undefined }, coverocr, profile).state, 'missing')
  await mkdir(path.join(dir, 'node_modules', 'dsh-maa-coverocr'), { recursive: true })
  await writeFile(path.join(dir, 'node_modules', 'dsh-maa-coverocr', 'package.json'), '{}')
  assert.equal(extensionStatus({ get: () => undefined }, coverocr, profile).state, 'installed')
  assert.equal(extensionStatus({ get: () => ({ apiVersion: 1 }) }, coverocr, profile).state, 'incompatible')
  assert.equal(extensionStatus({ get: () => ({ apiVersion: 2, version: '0.2.0' }) }, coverocr, profile).state, 'ready')
  // A host whose get() throws for an unknown service counts as missing.
  assert.equal(extensionStatus({ get: () => { throw new Error('no inject') } }, coverocr, null).state, 'missing')
})

test('install refuses to guess the profile and skips a companion that is already running', async () => {
  const unknown = await installExtension({ get: () => undefined }, 'coverocr', { env: {} })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /dsh plugin --profile <配置名> add dsh-maa-coverocr --allow-build=!onnxruntime-node/u)
  const dir = await profileDir('ready')
  const calls = []
  const ready = await installExtension({ get: name => name === 'profileContext' ? profileContext(dir) : name === 'maaCoverocr' ? { apiVersion: 2 } : undefined }, 'coverocr', { env: {}, spawnImpl: () => { calls.push(1); throw new Error('must not spawn') } })
  assert.equal(ready.kind, 'success')
  assert.match(ready.text, /无需重复安装/u)
  assert.equal(calls.length, 0)
  await assert.rejects(async () => installExtension({ get: () => undefined }, 'nope'), /未知的辅助插件/u)
})

function fakeSpawn(dir, { exitCode = 0, createPackage = true } = {}) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(async () => {
      if (createPackage) {
        await mkdir(path.join(dir, 'node_modules', 'dsh-maa-coverocr'), { recursive: true })
        await writeFile(path.join(dir, 'node_modules', 'dsh-maa-coverocr', 'package.json'), '{}')
      }
      child.stdout.emit('data', Buffer.from('+ dsh-maa-coverocr 0.1.0\n'))
      child.emit('close', exitCode)
    })
    return child
  }
  return { spawnImpl, calls }
}

test('install runs the host package manager in the profile and registers the bundle once', async () => {
  const dir = await profileDir('install')
  const ctx = { get: name => name === 'profileContext' ? profileContext(dir, { command: 'node', args: ['pnpm.cjs'], env: { PNPM_HOME: 'x' } }) : undefined }
  const { spawnImpl, calls } = fakeSpawn(dir)
  const result = await installExtension(ctx, 'coverocr', { spawnImpl, env: {} })
  assert.equal(result.kind, 'success', result.text)
  assert.equal(calls[0].command, 'node')
  assert.deepEqual(calls[0].args, ['pnpm.cjs', 'add', 'dsh-maa-coverocr', '--allow-build=!onnxruntime-node'])
  assert.equal(calls[0].options.cwd, dir)
  assert.equal(calls[0].options.env.PNPM_HOME, 'x')
  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['dsh-maa-cli', 'dsh-maa-coverocr'])
  await installExtension(ctx, 'coverocr', { spawnImpl, env: {} })
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).dsh.profile.bundles, ['dsh-maa-cli', 'dsh-maa-coverocr'])
})

test('a failed install leaves the profile manifest untouched and rejects unsafe specs', async () => {
  const dir = await profileDir('failed')
  const ctx = { get: name => name === 'profileContext' ? profileContext(dir) : undefined }
  const before = await readFile(path.join(dir, 'package.json'), 'utf8')
  const failed = await installExtension(ctx, 'coverocr', { ...fakeSpawn(dir, { exitCode: 1, createPackage: false }), env: {} })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /退出码 1/u)
  assert.equal(await readFile(path.join(dir, 'package.json'), 'utf8'), before)
  const unsafe = await installExtension(ctx, 'coverocr', { ...fakeSpawn(dir), env: { DSH_MAA_COVEROCR_SPEC: 'x & calc' } })
  assert.match(unsafe.text, /不安全/u)
})

test('Box comparison: ownership only, one missing operator still counts', () => {
  const box = { operators: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }
  const lineup = (names, cover = 'unknown') => ({ cover: { layout: cover }, operators: names.map(name => ({ name, certainty: 'certain', sources: ['cover'] })) })
  assert.equal(evaluateVideoLineup(lineup(['A', 'B']), box).verdict, 'ok')
  assert.deepEqual(evaluateVideoLineup(lineup(['A', 'X']), box), { verdict: 'support', matches: true, complete: false, missing: ['X'], operators: lineup(['A', 'X']).operators })
  assert.equal(evaluateVideoLineup(lineup(['X', 'Y']), box).verdict, 'missing')
  assert.equal(evaluateVideoLineup(lineup([]), box).verdict, 'unknown')
  assert.equal(evaluateVideoLineup(lineup(['A'], 'squad'), box).complete, true)
})

test('maa_video_lineup asks for the companion when it is not installed', async () => {
  const { tool } = hostContext({})
  const result = await tool('maa_video_lineup').execute({ videos: ['BV1upWJ6YEf3'] }, exec())
  assert.equal(result.status, 'needs_extension')
  assert.match(result.summary, /\/maa ext install coverocr/u)
})

test('maa_video_lineup passes MAA names and resource dir to the companion and compares with the Box', async () => {
  const requests = []
  const service = {
    apiVersion: 2, version: '0.2.0',
    async analyzeVideo(request) {
      requests.push(request)
      if (request.video === 'bad') throw new Error('B 站接口错误 -404')
      return {
        video: { bvid: 'BV1upWJ6YEf3', url: 'https://www.bilibili.com/video/BV1upWJ6YEf3/', title: 'TL-EX-8突袭 5人摆完挂机', owner: 'UP' },
        operators: ['维什戴尔', '结城理', '白面鸮', '冻河', '圣聆初雪'].map(name => ({ name, certainty: 'certain', sources: ['cover'] })),
        cover: { status: 'recognized', layout: 'squad', detail: '', ignored: [] },
        text: {}, maaCodes: [], warnings: [],
      }
    },
  }
  const { tool } = hostContext({ maaCoverocr: service })
  const result = await tool('maa_video_lineup').execute({ videos: ['BV1upWJ6YEf3', 'bad'] }, exec())
  assert.equal(result.status, 'ok')
  assert.equal(requests[0].resourceDir, resourceDir)
  assert.deepEqual([...requests[0].operatorNames].sort(), ['冻河', '圣聆初雪', '白面鸮', '结城理', '维什戴尔'].sort())
  assert.match(result.summary, /【可抄（需借助战）】TL-EX-8突袭/u)
  assert.match(result.summary, /缺 1 名：圣聆初雪/u)
  assert.match(result.summary, /https:\/\/www\.bilibili\.com\/video\/BV1upWJ6YEf3\//u)
  assert.match(result.summary, /【读取失败】bad/u)
  const data = JSON.parse(result.data)
  assert.equal(data.results[0].verdict, 'support')
  assert.equal(data.results[0].complete, true)
})

test('maa_video_lineup searches by stage and evaluates cover-only results', async () => {
  const searches = []
  const service = {
    apiVersion: 2, version: '0.2.0',
    async searchVideos(request) {
      searches.push(request)
      return { query: request.query, videos: [{
        video: { bvid: 'BV1upWJ6YEf3', url: 'https://www.bilibili.com/video/BV1upWJ6YEf3/', title: 'TL-EX-8 摆完挂机', owner: 'UP' },
        operators: [{ name: '维什戴尔', certainty: 'certain', sources: ['cover'] }],
        cover: { status: 'recognized', layout: 'squad', detail: '', ignored: [] }, text: {}, maaCodes: [], warnings: [],
      }] }
    },
  }
  const result = await hostContext({ maaCoverocr: service }).tool('maa_video_lineup').execute({ query: 'TL-EX-8', limit: 3 }, exec())
  assert.equal(result.status, 'ok')
  assert.equal(searches[0].query, 'TL-EX-8')
  assert.equal(searches[0].limit, 3)
  assert.match(result.summary, /B 站搜索：明日方舟 TL-EX-8（只读取封面，不下载视频）/u)
  assert.match(result.summary, /必须逐条保留上面的对应视频链接/u)
  assert.match(result.summary, /【可抄】TL-EX-8 摆完挂机/u)
})

test('/maa ext reports status through the local command', async () => {
  const { command } = hostContext({ maaCoverocr: { apiVersion: 2, version: '0.2.0' } })
  const result = await command('maa').handler({ agent: { id: 'a', session: {} }, rawInput: 'ext', signal: AbortSignal.timeout(5000) })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /coverocr｜dsh-maa-coverocr｜已启用（0\.2\.0）/u)
})
