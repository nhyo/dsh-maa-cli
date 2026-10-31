import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { actionArguments, DEFAULT_MAA_CLI_PATH, MAA_CLI_PATH, queryArguments, resolveMaaCliPath, runMaa, startMaa } from '../src/runtime/runner.js'
import { runtimeLayout } from '../src/runtime/runtime.js'
import { apply, classifyMaaExecution } from '../src/index.js'
import { buildTaskDocument, generatedTaskPath, summarizePlan, writeGeneratedTask } from '../src/commands/planner.js'
import { clearPendingPlansForTest, consumeConfirmedPlan, consumePlanFromHumanGesture, peekPendingPlan, preparePendingPlan, updatePendingPlan } from '../src/commands/confirmation.js'
import { parseLocalMaaCommand } from '../src/commands/local-command.js'
import { stateFilePath } from '../src/runtime/state.js'
import { operatorBoxFilePath, saveOperatorBox } from '../src/operators/operator-box.js'
import { createWorkflowExecution } from '../src/agent/workflow-manager.js'

// Pending plans now live on disk, so the tests keep them out of the real
// ~/.dsh/maa-cli directory.
process.env.DSH_MAA_CLI_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-confirmation-'))

test('classifies MAA process completion separately from task execution', () => {
  assert.equal(classifyMaaExecution({ exitCode: 0, stdout: '[Fight] Completed', stderr: '' }, true).status, 'verified')
  assert.equal(classifyMaaExecution({ exitCode: 0, stdout: '[Copilot] Unstarted', stderr: '' }, true).status, 'unverified')
  assert.equal(classifyMaaExecution({ exitCode: 0, stdout: '[Fight] Failed', stderr: '' }, true).status, 'failed')
  assert.equal(classifyMaaExecution({ exitCode: 7, stdout: '', stderr: 'boom' }, false).status, 'failed')
})

test('registers a zero-token command plus prepare-only model tools', () => {
  const tools = []
  const commands = []
  apply({
    tools: { register: tool => tools.push(tool) },
    commands: { register: command => commands.push(command) },
  })
  assert.deepEqual(commands.map(command => command.name), ['maa'])
  assert.deepEqual(tools.map(tool => tool.name), ['maa_query', 'maa_runtime_instruction', 'maa_operator_box', 'maa_depot', 'maa_goal_manager', 'maa_workflow_manager', 'maa_training_advice', 'maa_prepare_plan', 'maa_prepare_strategy', 'maa_prepare_note', 'maa_doctor', 'maa_runtime'])
  assert.deepEqual(tools[0].parameters.required, ['operation'])
  assert.deepEqual(tools[1].parameters.required, ['action'])
  assert.deepEqual(tools[6].parameters.required, ['useCached'])
  assert.match(tools[6].description, /MANDATORY for every operator training-advice request/)
  assert.match(tools[6].description, /restarting DSH Desktop/)
  assert.match(tools[6].description, /do not perform unnecessary recursive searches or repeated scans/)
  assert.deepEqual(tools[7].parameters.required, ['purpose', 'steps'])
  assert.deepEqual(tools[8].parameters.required, ['purpose', 'kind', 'task'])
  assert.match(tools[8].description, /real Integrated Strategy resource changes or a real Copilot job/)
  assert.deepEqual(tools[9].parameters.required, ['note'])
  assert.match(tools[9].description, /抓\/拿\/捞\/取\/选\/选择\/招募 all mean recruit/)
  assert.deepEqual(tools[10].parameters.properties, {})
  assert.match(tools[7].description, /does not create another model call/)
  assert.match(tools[2].description, /Always call this/)
})

test('registered slash command prepares and exposes the fight settings panel without executing MAA', async () => {
  const commands = []
  apply({ tools: { register: () => {} }, commands: { register: command => commands.push(command) } })
  const maa = commands.find(command => command.name === 'maa')
  const agent = {
    id: 'slash-panel-test',
    session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] },
  }
  await clearPendingPlansForTest()

  const prepared = await maa.handler({ agent, rawInput: 'fight', signal: AbortSignal.timeout(2_000) })
  assert.equal(prepared.kind, 'success')
  assert.match(prepared.text, /MAA 计划待确认/)

  const peeked = await maa.handler({ agent, rawInput: 'peek', signal: AbortSignal.timeout(2_000) })
  assert.equal(peeked.kind, 'success')
  const payload = JSON.parse(peeked.text)
  assert.equal(payload.panel.type, 'Fight')
  assert.equal(payload.panel.title, '理智作战')
  assert.equal(payload.panel.values.times, 1)
  assert.ok(payload.panel.fields.some(field => field.key === 'stage'))
  assert.ok(payload.panel.fields.some(field => field.key === 'medicine'))
  await clearPendingPlansForTest()
})

test('workflow confirmation exposes read-only steps and submits no task overrides', async () => {
  const commands = []
  apply({ tools: { register: () => {} }, commands: { register: command => commands.push(command) } })
  const maa = commands.find(command => command.name === 'maa')
  const agent = { id: 'workflow-panel-test', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] } }
  const execution = await createWorkflowExecution({ name: '安全日常', capabilitySignature: 'test', steps: [{ kind: 'maa', title: '启动', maa: { type: 'StartUp', params: { client_type: 'Official', start_game_enabled: true } } }] })
  const pending = await preparePendingPlan(agent, { planSummary: '安全日常', document: { tasks: execution.steps.map(step => step.maa) }, workflowExecutionId: execution.id })
  const peeked = await maa.handler({ agent, rawInput: `peek ${pending.confirmationCode}`, signal: AbortSignal.timeout(2_000) })
  assert.equal(peeked.kind, 'success')
  const payload = JSON.parse(peeked.text)
  assert.equal(payload.panel.type, 'Workflow')
  assert.deepEqual(payload.panel.fields, [])
  assert.deepEqual(payload.panel.values, {})
  assert.match(payload.panel.notes[0].text, /启动/u)
})

test('daily goal tool creates a persisted workflow and one-time confirmation without running MAA', async () => {
  const tools = []
  apply({ tools: { register: tool => tools.push(tool) }, commands: { register: () => {} } })
  const goalTool = tools.find(tool => tool.name === 'maa_goal_manager')
  let concluded = false
  const agent = { id: 'daily-goal-test', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] } }
  const result = await goalTool.execute({ action: 'prepare', kind: 'daily', title: '今日安全日常', budget: { allowStone: false, maxMedicine: 0, maxExpiringMedicine: 0 } }, {
    agent, signal: AbortSignal.timeout(3_000), concludeTurn: () => { concluded = true },
  })
  assert.equal(result.status, 'pending_confirmation')
  assert.match(result.goalId, /^GOAL-/u)
  assert.match(result.workflowId, /^WFR-/u)
  assert.match(result.confirmationCode, /^MAA-/u)
  assert.equal(concluded, true)
  const pending = await peekPendingPlan(agent)
  assert.equal(pending.goalId, result.goalId)
  assert.equal(pending.workflowExecutionId, result.workflowId)
  assert.deepEqual(pending.document.tasks.map(task => task.type), ['StartUp', 'Infrast', 'Mall', 'Award'])
})

test('stores a note preview without replacing or extending its confirmation', async () => {
  await clearPendingPlansForTest()
  const agent = { id: 'note-preview-state', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] } }
  await preparePendingPlan(agent, { purpose: 'test', document: { tasks: [] } }, { code: 'MAA-ABC123', now: 1000 })
  await updatePendingPlan(agent, current => ({ ...current, notePreview: { status: 'ready' } }), { now: 1100 })
  const stored = await peekPendingPlan(agent)
  assert.equal(stored.confirmationCode, 'MAA-ABC123')
  assert.equal(stored.preparedAt, 1000)
  assert.deepEqual(stored.notePreview, { status: 'ready' })
  await assert.rejects(
    updatePendingPlan(agent, current => ({ ...current, confirmationCode: 'MAA-000000' }), { now: 1200 }),
    /不能替换确认码/u,
  )
  await clearPendingPlansForTest()
})

test('training advice asks about the cache before any recommendation', async () => {
  const tools = []
  apply({ tools: { register: tool => tools.push(tool) }, commands: { register: () => {} } })
  const advice = tools.find(tool => tool.name === 'maa_training_advice')
  await rm(operatorBoxFilePath(), { force: true })
  assert.equal((await advice.execute({ useCached: false }, {})).status, 'needs_scan')

  await saveOperatorBox({
    version: 1, scannedAt: '2026-10-29T12:00:00.000Z',
    operators: [{ id: 'char_1035_wisdel', name: '维什戴尔', rarity: 6, elite: 1, level: 80, potential: 1 }],
  })
  const cached = await advice.execute({ useCached: false }, {})
  assert.equal(cached.status, 'needs_choice')
  assert.match(cached.summary, /直接使用这份缓存生成培养建议，还是重新扫描/)
  await rm(operatorBoxFilePath(), { force: true })
})

test('parses common slash commands without a model', () => {
  assert.deepEqual(parseLocalMaaCommand('fight 1-7 2').steps[0], {
    type: 'Fight', stage: '1-7', times: 2, medicine: 0, expiringMedicine: 0, stone: 0,
  })
  assert.equal(parseLocalMaaCommand('刷 1-7 两次').steps[0].times, 2)
  assert.equal(parseLocalMaaCommand('启动游戏').kind, 'plan')
  assert.equal(parseLocalMaaCommand('启动游戏').steps[0].type, 'StartUp')
  assert.equal(parseLocalMaaCommand('基建换班').steps[0].drones, '_NotUse')
  assert.equal(parseLocalMaaCommand('confirm maa-a1b2c3').confirmationCode, 'MAA-A1B2C3')
  assert.equal(parseLocalMaaCommand('停止任务').kind, 'stop')
  assert.deepEqual(parseLocalMaaCommand('这把肉鸽打完就停').request, { action: 'stop_after_current' })
  assert.deepEqual(parseLocalMaaCommand('第五层 Boss 前停止').request, { action: 'stop_before_boss', floor: 5 })
  assert.deepEqual(parseLocalMaaCommand('再打两局就停').request, { action: 'stop_after_runs', count: 2 })
  assert.deepEqual(parseLocalMaaCommand('取消刚才的停止要求').request, { action: 'cancel_stop' })
  assert.deepEqual(parseLocalMaaCommand('现在打到哪里了').request, { action: 'status' })
  assert.deepEqual(parseLocalMaaCommand('接下来优先招结城理').request, { action: 'prefer_recruit', operator: '结城理' })
  assert.equal(parseLocalMaaCommand('setup').kind, 'setup')
  assert.deepEqual(parseLocalMaaCommand('扫描干员Box').steps.map(step => step.type), ['OperBox'])
  assert.deepEqual(parseLocalMaaCommand('更新数据').steps.map(step => step.type), ['OperBox', 'Depot'])
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
  assert.deepEqual(actionArguments('run_task', 'dsh-generated', true, true), ['run', 'dsh-generated', '--user-resource', '--batch'])
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

test('starts a long maa-cli task in the background and settles it on exit', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-detached-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cliPath = path.join(directory, 'fake-maa.cmd')
  await writeFile(cliPath, '@echo off\r\necho [Fight] Completed\r\nexit /b 0\r\n')

  const handle = startMaa(['run', 'Task', '--batch'], { cliPath, hardTimeoutMs: 20_000 })
  assert.equal(typeof handle.pid, 'number')
  const started = Date.now()
  const result = await handle.done
  // The caller regains control immediately; the promise settles when the child
  // exits, not when it is started.
  assert.ok(Date.now() - started < 20_000)
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /\[Fight\] Completed/u)
  assert.equal(result.terminationSignal, '')
})

test('a detached maa-cli task can be killed through its abort signal', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-detached-kill-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cliPath = path.join(directory, 'slow-maa.cmd')
  // A batch file that keeps the process tree alive long enough to be killed.
  await writeFile(cliPath, '@echo off\r\nping -n 30 127.0.0.1 > nul\r\nexit /b 0\r\n')

  const controller = new AbortController()
  const handle = startMaa(['run', 'Task', '--batch'], { cliPath, signal: controller.signal, hardTimeoutMs: 60_000 })
  controller.abort()
  await assert.rejects(handle.done, error => error?.name === 'AbortError')
})
