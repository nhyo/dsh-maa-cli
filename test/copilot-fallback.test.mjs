import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_MAA_CLI_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-copilot-fallback-'))
const { COPILOT_MAX_SWITCHES, createCopilotFallback, pickCopilotFallbacks, runFinishedNotification } = await import('../src/index.js')
const { beginRun, getRun, summarizeRun } = await import('../src/commands/run-state.js')
const { isCopilotJobFailure } = await import('../src/agent/recovery-manager.js')
const { desktopNotify, notificationsEnabled, toastScript } = await import('../src/runtime/notify.js')

const job = (id, overrides = {}) => ({
  id: String(id),
  job: { kind: 'Copilot', stageName: 'main_01-07', title: `作业${id}`, ...overrides.job },
  ownership: { status: 'ok', missing: [], weak: [], ...overrides.ownership },
  content: { stage_name: 'main_01-07', doc: { title: `作业${id}` } },
})

test('backup jobs are same-stage, same-kind, not known to lack operators, and capped at three', () => {
  const primary = job(1)
  const ranked = [
    primary,
    job(2),
    job(3, { ownership: { status: 'missing', missing: ['能天使'] } }),
    job(4, { job: { stageName: 'main_01-08' } }),
    job(5, { job: { kind: 'SSSCopilot' } }),
    job(6, { ownership: { status: 'unknown' } }),
    job(7),
    job(8),
    job(9),
  ]
  assert.deepEqual(pickCopilotFallbacks(ranked, primary).map(item => item.id), ['2', '6', '7'])
  assert.equal(COPILOT_MAX_SWITCHES, 3)
})

test('a failed job is swapped at most three times, recorded on the run, and announced every time', async () => {
  const run = await beginRun({ purpose: '抄作业 1-7', planSummary: 'x', confirmationCode: 'MAA-C0P11T', sessionId: 's', taskTypes: ['Copilot'] })
  const target = path.join(process.env.DSH_MAA_CLI_STATE_DIR, 'job.json')
  await writeFile(target, '{"stage_name":"main_01-07","doc":{"title":"作业1"}}\n')
  const notifications = []
  const fallback = createCopilotFallback({
    run, target, current: { id: '1', title: '作业1' },
    fallbacks: [2, 3, 4, 5].map(id => ({ id: String(id), title: `作业${id}`, content: { stage_name: 'main_01-07', doc: { title: `作业${id}` } } })),
    notify: (title, body) => notifications.push({ title, body }),
  })
  await fallback.announce()
  let record = await getRun(run.id)
  assert.deepEqual(record.progress.copilot.current, { id: '1', title: '作业1' })
  assert.equal(record.progress.copilot.remaining, 3, 'only three backups are kept even if more were offered')

  for (const expected of ['2', '3', '4']) {
    assert.equal(await fallback.next({ reason: 'MaaCore 任务链异常：UnknownException' }), true)
    assert.equal(JSON.parse(await readFile(target, 'utf8')).doc.title, `作业${expected}`)
  }
  assert.equal(await fallback.next({ reason: 'again' }), false, 'a fourth switch is refused')

  record = await getRun(run.id)
  assert.equal(record.progress.copilot.switches.length, 3)
  assert.deepEqual(record.progress.copilot.current, { id: '4', title: '作业4' })
  assert.equal(record.progress.copilot.remaining, 0)
  const history = record.recovery.history.filter(entry => entry.action === 'switch_copilot')
  assert.equal(history.length, 3)
  assert.match(history[0].detail, /maa:\/\/1 失败.*第 1\/3 份：maa:\/\/2「作业2」/u)
  assert.equal(notifications.length, 3)
  assert.ok(notifications.every(item => item.title === 'MAA 自动换作业'))
  assert.match(notifications[2].body, /第 3\/3 份：maa:\/\/4/u)
  assert.match(summarizeRun(record).progress.copilot.current.id, /^4$/u)
})

test('only a job-level copilot failure triggers a switch', () => {
  const failed = { category: 'taskchain_exception', reason: 'x' }
  const copilotError = [{ event: 'TaskChainError', body: { taskchain: 'Copilot' } }]
  assert.equal(isCopilotJobFailure({ callbacks: copilotError, diagnosis: failed }), true)
  assert.equal(isCopilotJobFailure({ result: { stdout: 'Summary\n[Copilot] Failed\n' }, diagnosis: { category: 'task_failed' } }), true)
  assert.equal(isCopilotJobFailure({ callbacks: copilotError, diagnosis: { category: 'adb_connection' } }), false, 'emulator trouble is not the job’s fault')
  assert.equal(isCopilotJobFailure({ callbacks: copilotError, diagnosis: { category: 'stopped' } }), false)
  assert.equal(isCopilotJobFailure({ callbacks: [{ event: 'TaskChainError', body: { taskchain: 'Fight' } }], diagnosis: failed }), false)
  assert.equal(isCopilotJobFailure({ callbacks: [...copilotError, { event: 'TaskChainCompleted', body: { taskchain: 'Copilot' } }], diagnosis: failed }), false)
})

test('run endings are announced except for a stop the user clicked', () => {
  const base = { purpose: '清理基建', summary: 'MAA 进程已正常结束。', duration: '1 分 02 秒' }
  assert.deepEqual(runFinishedNotification({ ...base, status: 'succeeded' }), { title: 'MAA 任务已完成', body: '清理基建\nMAA 进程已正常结束。\n用时 1 分 02 秒' })
  assert.equal(runFinishedNotification({ ...base, status: 'failed' }).title, 'MAA 任务失败')
  assert.equal(runFinishedNotification({ ...base, status: 'stopped' }), null)
  assert.equal(runFinishedNotification({ ...base, status: 'stopped' }, { conditionStop: true }).title, 'MAA 任务已按条件停止')
  assert.equal(runFinishedNotification({ ...base, status: 'running' }), null)
})

test('desktop notifications are opt-out, silent under node --test, and safely quoted', () => {
  assert.equal(notificationsEnabled({}), true)
  assert.equal(notificationsEnabled({ DSH_MAA_NOTIFY: '0' }), false)
  assert.equal(notificationsEnabled({ NODE_TEST_CONTEXT: 'child' }), false)
  assert.equal(notificationsEnabled({ NODE_TEST_CONTEXT: 'child', DSH_MAA_NOTIFY: '1' }), true)

  const script = toastScript("Tom's <job>", 'a & b')
  assert.match(script, /Tom&apos;s &lt;job&gt;/u)
  assert.match(script, /a &amp; b/u)
  assert.match(script, /'\{1AC14E77[^']*powershell\.exe'/u, 'PowerShell literals stay single-quoted')

  const calls = []
  const fakeSpawn = (command, args, options) => { calls.push({ command, args, options }); return { on() {}, unref() {} } }
  assert.equal(desktopNotify('t', 'b', { env: { NODE_TEST_CONTEXT: 'child' }, platform: 'win32', spawn: fakeSpawn }), false)
  assert.equal(calls.length, 0)
  assert.equal(desktopNotify('标题', '内容', { env: { DSH_MAA_NOTIFY: '1' }, platform: 'win32', spawn: fakeSpawn }), true)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.equal(calls[0].options.windowsHide, true)
  const encoded = calls[0].args[calls[0].args.indexOf('-EncodedCommand') + 1]
  assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /标题[\s\S]*内容/u)
  assert.equal(desktopNotify('t', 'b', { env: { DSH_MAA_NOTIFY: '1' }, platform: 'win32', spawn: () => { throw new Error('no powershell') } }), false, 'a missing shell never throws')
})
