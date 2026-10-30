import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { actionArguments, DEFAULT_MAA_CLI_PATH, MAA_CLI_PATH, queryArguments, resolveMaaCliPath, runMaa } from './runner.js'
import { runtimeLayout } from './runtime.js'
import { apply } from './index.js'
import { buildTaskDocument, generatedTaskPath, summarizePlan, writeGeneratedTask } from './planner.js'
import { clearPendingPlansForTest, consumeConfirmedPlan, consumePlanFromHumanGesture, preparePendingPlan } from './confirmation.js'
import { parseLocalMaaCommand } from './local-command.js'
import { stateFilePath } from './state.js'

// Pending plans now live on disk, so the tests keep them out of the real
// ~/.dsh/maa-cli directory.
process.env.DSH_MAA_CLI_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-confirmation-'))

test('registers a zero-token command plus prepare-only model tools', () => {
  const tools = []
  const commands = []
  apply({
    tools: { register: tool => tools.push(tool) },
    commands: { register: command => commands.push(command) },
  })
  assert.deepEqual(commands.map(command => command.name), ['maa'])
  assert.deepEqual(tools.map(tool => tool.name), ['maa_query', 'maa_operator_box', 'maa_prepare_plan', 'maa_doctor', 'maa_runtime'])
  assert.deepEqual(tools[0].parameters.required, ['operation'])
  assert.deepEqual(tools[2].parameters.required, ['purpose', 'steps'])
  assert.deepEqual(tools[3].parameters.properties, {})
  assert.match(tools[2].description, /does not create another model call/)
  assert.match(tools[1].description, /Always call this/)
})

test('parses common slash commands without a model', () => {
  assert.deepEqual(parseLocalMaaCommand('fight 1-7 2').steps[0], {
    type: 'Fight', stage: '1-7', times: 2, medicine: 0, expiringMedicine: 0, stone: 0,
  })
  assert.equal(parseLocalMaaCommand('刷 1-7 两次').steps[0].times, 2)
  assert.equal(parseLocalMaaCommand('启动游戏').steps[0].type, 'StartUp')
  assert.equal(parseLocalMaaCommand('基建换班').steps[0].drones, '_NotUse')
  assert.equal(parseLocalMaaCommand('confirm maa-a1b2c3').confirmationCode, 'MAA-A1B2C3')
  assert.equal(parseLocalMaaCommand('停止任务').kind, 'stop')
  assert.equal(parseLocalMaaCommand('setup').kind, 'setup')
  assert.deepEqual(parseLocalMaaCommand('扫描干员Box').steps.map(step => step.type), ['StartUp', 'OperBox'])
  assert.throws(() => parseLocalMaaCommand('任意 shell 命令'), /无法识别/)
})

test('a human command-plane gesture consumes the pending plan once', async () => {
  await clearPendingPlansForTest()
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  const agent = { id: 'gesture-session', session: { snapshotEvents: () => events } }
  await preparePendingPlan(agent, { document: {}, planSummary: 'gesture' }, { code: 'MAA-112233', now: 1_000 })
  assert.equal((await consumePlanFromHumanGesture(agent, 'MAA-112233', { now: 2_000 })).planSummary, 'gesture')
  await assert.rejects(consumePlanFromHumanGesture(agent, 'MAA-112233', { now: 2_000 }), /没有待确认/)
})

test('requires a new explicit user turn and consumes a confirmation only once', async () => {
  await clearPendingPlansForTest()
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '刷 1-7 一次' }] } },
  ]
  const agent = { id: 'session-a', session: { snapshotEvents: () => events } }
  const document = buildTaskDocument([{ type: 'Fight', stage: '1-7', times: 1 }])
  const prepared = await preparePendingPlan(agent, { document, planSummary: 'fight' }, { code: 'MAA-A1B2C3', now: 1_000 })
  assert.equal(prepared.confirmationPhrase, '确认执行 MAA-A1B2C3')
  assert.equal(prepared.persistedAt, stateFilePath())

  const stored = JSON.parse(await readFile(stateFilePath(), 'utf8'))
  assert.equal(stored.plans['session-a'].confirmationCode, 'MAA-A1B2C3')

  await assert.rejects(consumeConfirmedPlan({ agent }, 'MAA-A1B2C3', { now: 2_000 }), /same DSH turn/)
  events.push(
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '确认执行 MAA-A1B2C3' }] } },
  )
  assert.equal((await consumeConfirmedPlan({ agent }, 'MAA-A1B2C3', { now: 2_000 })).planSummary, 'fight')
  await assert.rejects(consumeConfirmedPlan({ agent }, 'MAA-A1B2C3', { now: 2_000 }), /No pending/)
})

test('rejects model-inferred, cross-session, wrong, and expired confirmations', async () => {
  await clearPendingPlansForTest()
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  const agent = { id: 'session-a', session: { snapshotEvents: () => events } }
  await preparePendingPlan(agent, { document: {}, planSummary: 'test' }, { code: 'MAA-ABC123', now: 1_000 })
  events.push({ type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } })
  await assert.rejects(consumeConfirmedPlan({ agent }, 'MAA-WRONG1', { now: 2_000 }), /does not match/)
  await assert.rejects(consumeConfirmedPlan({ agent }, 'MAA-ABC123', { now: 2_000 }), /must explicitly contain/)
  const other = { id: 'session-b', session: agent.session }
  await assert.rejects(consumeConfirmedPlan({ agent: other }, 'MAA-ABC123', { now: 2_000 }), /No pending/)
  await assert.rejects(consumeConfirmedPlan({ agent }, 'MAA-ABC123', { now: 1_000 + 30 * 60_000 + 1 }), /expired/)
})

test('allows the maa-cli wrapper path to be overridden', () => {
  // A machine that already bootstrapped the plugin-private runtime resolves the
  // default path to that runtime, so compare against the same resolver and pin
  // the "no runtime" assertions to an empty runtime directory.
  const noRuntime = { DSH_MAA_CLI_RUNTIME_DIR: path.join(os.tmpdir(), `dsh-maa-cli-no-runtime-${process.pid}`) }
  assert.equal(MAA_CLI_PATH, resolveMaaCliPath())
  assert.equal(resolveMaaCliPath(noRuntime), runtimeLayout(noRuntime).executable)
  assert.equal(resolveMaaCliPath({ ...noRuntime, DSH_MAA_CLI_PATH: 'D:\\maa\\maa-cli.cmd' }), 'D:\\maa\\maa-cli.cmd')
  assert.equal(resolveMaaCliPath({ ...noRuntime, MAA_CLI_PATH: 'D:\\x.cmd' }), 'D:\\x.cmd')
  assert.equal(resolveMaaCliPath({ ...noRuntime, DSH_MAA_CLI_PATH: '   ' }), runtimeLayout(noRuntime).executable)
})

test('rejects commands outside the allowlists', () => {
  assert.throws(() => queryArguments('install'), /Unsupported/)
  assert.throws(() => actionArguments('fight'), /Unsupported/)
  assert.throws(() => actionArguments('run_task', 'bad & command'), /taskName/)
})

test('maps the approved action vocabulary', () => {
  assert.deepEqual(actionArguments('startup'), ['startup'])
  assert.deepEqual(actionArguments('closedown'), ['closedown'])
  assert.deepEqual(actionArguments('run_task', 'daily-safe'), ['run', 'daily-safe'])
  assert.deepEqual(actionArguments('run_task', 'dsh-generated', true), ['run', 'dsh-generated', '--batch'])
})

test('builds an ordered natural-language plan with resource-safe defaults', () => {
  const document = buildTaskDocument([
    { type: 'StartUp' },
    { type: 'Fight', stage: '1-7', times: 3 },
    { type: 'Infrast' },
    { type: 'Mall' },
    { type: 'Award' },
    { type: 'CloseDown' },
  ])
  assert.deepEqual(document.tasks.map(task => task.type), ['StartUp', 'Fight', 'Infrast', 'Mall', 'Award', 'CloseDown'])
  assert.deepEqual(document.tasks[1].params, { stage: '1-7', times: 3, medicine: 0, expiring_medicine: 0, stone: 0, series: 3 })
  assert.equal(document.tasks[3].params.shopping, false)
  assert.equal(document.tasks[3].params.force_shopping_if_credit_full, false)
  assert.equal(document.tasks[4].params.mail, false)
  assert.match(summarizePlan([{ type: 'Fight', stage: '1-7', times: 3 }]), /源石0/)
})

test('writes the generated task into the config directory used by the active maa-cli', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-active-config-'))
  const document = buildTaskDocument([{ type: 'Fight', stage: '1-7', times: 1 }])
  const written = await writeGeneratedTask(document, { configDir })
  assert.equal(written.path, generatedTaskPath(configDir))
  assert.equal(written.path, path.join(configDir, 'tasks', 'dsh-generated.json'))
  assert.deepEqual(JSON.parse(await readFile(written.path, 'utf8')), document)
  assert.throws(() => generatedTaskPath('relative-config'), /absolute path/)
})

test('accepts clientType on Fight and promotes it to the whole plan', () => {
  const document = buildTaskDocument([
    { type: 'StartUp', clientType: 'Official' },
    { type: 'Fight', stage: '1-7', times: 2, clientType: 'Official' },
  ])
  assert.equal(document.client_type, 'Official')
  assert.equal(document.tasks[0].params.client_type, 'Official')
  assert.equal('client_type' in document.tasks[1].params, false)
  assert.equal(document.tasks[1].params.times, 2)
  assert.equal(document.tasks[1].params.series, 2)
  assert.throws(() => buildTaskDocument([
    { type: 'StartUp', clientType: 'Official' },
    { type: 'Fight', stage: '1-7', times: 1, clientType: 'Bilibili' },
  ]), /must match/)
})

test('uses one in-game consecutive battle instead of repeating single battles', () => {
  assert.deepEqual(buildTaskDocument([{ type: 'Fight', stage: '1-7', times: 10 }]).tasks[0].params, {
    stage: '1-7', times: 10, medicine: 0, expiring_medicine: 0, stone: 0, series: 10,
  })
  assert.equal(buildTaskDocument([{ type: 'Fight', stage: '1-7', times: 11 }]).tasks[0].params.series, 0)
  assert.throws(() => buildTaskDocument([{ type: 'Fight', stage: '1-7', times: 10, series: 1 }]), /not supported/)
})

test('rejects unbounded, unsupported, or malformed game plans', () => {
  assert.throws(() => buildTaskDocument([{ type: 'Fight', stage: '1-7' }]), /Fight.times/)
  assert.throws(() => buildTaskDocument([{ type: 'Fight', stage: '1-7', times: 0 }]), /Fight.times/)
  assert.throws(() => buildTaskDocument([{ type: 'Fight', stage: '1-7', times: 1, command: 'shutdown' }]), /not supported/)
  assert.throws(() => buildTaskDocument([{ type: 'Custom', taskNames: ['Bad & command'] }]), /invalid/)
  assert.throws(() => buildTaskDocument([{ type: 'Roguelike', theme: 'Sami' }]), /startsCount/)
})

test('runs the read-only version query through the wrapper', async () => {
  const result = await runMaa(queryArguments('version'))
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /maa-cli v0\.7\.7/)
  assert.match(result.stdout, /MaaCore v6\.20\.1/)
})

test('aborting runMaa terminates its exact Windows process tree', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-stop-'))
  const wrapper = path.join(root, 'slow.cmd')
  await writeFile(wrapper, '@echo off\r\nping 127.0.0.1 -n 30 >nul\r\n', 'utf8')
  const controller = new AbortController()
  const started = Date.now()
  const running = runMaa(['version'], { cliPath: wrapper, signal: controller.signal, timeoutMs: 30_000 })
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(running, error => error?.name === 'AbortError')
  assert.ok(Date.now() - started < 5_000)
})

test('passes a narrow environment patch to maa-cli without shell interpolation', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-env-'))
  const wrapper = path.join(root, 'env.cmd')
  await writeFile(wrapper, '@echo off\r\necho %MAA_LOG%/%MAA_LOG_PREFIX%\r\n', 'utf8')
  const result = await runMaa(['version'], { cliPath: wrapper, envPatch: { MAA_LOG: 'info', MAA_LOG_PREFIX: 'Never' } })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), 'info/Never')
})

test('lists saved custom tasks without failing on an empty set', async () => {
  const result = await runMaa(queryArguments('list'))
  assert.equal(result.exitCode, 0)
  const names = result.stdout === '' ? [] : result.stdout.split(/\r?\n/)
  for (const name of names) assert.match(name, /^[A-Za-z0-9._-]{1,64}$/)
})

test('resolves maa-cli from the plugin runtime when it exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-runtime-'))
  const env = { DSH_MAA_CLI_RUNTIME_DIR: root }
  assert.equal(resolveMaaCliPath(env), runtimeLayout(env).executable)
  assert.equal(resolveMaaCliPath({ ...env, DSH_MAA_CLI_PATH: 'C:\\custom\\maa.cmd' }), 'C:\\custom\\maa.cmd')

  const layout = runtimeLayout(env)
  await mkdir(layout.bin, { recursive: true })
  await writeFile(layout.executable, '')
  assert.equal(resolveMaaCliPath(env), layout.executable)
})
