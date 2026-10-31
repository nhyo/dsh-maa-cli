// End-to-end lifecycle tests for the confirmation panel and the run panel.
//
// Every test drives the REAL client module (src/client/index.js) rendered by a
// hooks-faithful mini renderer, talking over IPC to a REAL plugin host process
// (src/index.js) that spawns a fake maa-cli with a real child process tree.
// Nothing here talks to an emulator or the game: this is not a device test.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createLocalStorage, createWorkspace, isAlive, killQuietly, loadClient, waitFor } from './helpers/dsh-harness.mjs'

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

async function readRuns(workspace) {
  try {
    return JSON.parse(await readFile(path.join(workspace.env.DSH_MAA_CLI_STATE_DIR, 'runs.json'), 'utf8')).runs
  } catch { return [] }
}

async function preparePlan(hostRef, sessionId = SESSION_A) {
  const result = await hostRef.current.execute(sessionId, '/maa fight')
  assert.equal(result.kind, 'success', result.text)
  return result.text.match(/MAA-[A-F0-9]{6}/u)[0]
}

async function setup(t, options = {}) {
  const workspace = await createWorkspace(t)
  await workspace.setMode(options.mode ?? 'slow')
  const hostRef = { current: await workspace.startHost() }
  const localStorage = createLocalStorage()
  const page = loadClient({ host: hostRef, localStorage, confirmAnswer: options.confirmAnswer })
  return { workspace, hostRef, localStorage, page }
}

// Prepare `/maa fight` on the host, then show the conversation: the dock reads
// `/maa status` once on mount and raises the pending plan from the host.
async function openPlanInDock(env) {
  const code = await preparePlan(env.hostRef)
  env.page.show(SESSION_A)
  await waitDock(env.page, 'plan')
  assert.match(env.page.text(), new RegExp(code))
  return code
}

async function waitDock(page, kind, label = kind) {
  await waitFor(async () => { await page.settle(); return page.dock()?.props['data-maa-dock'] === kind }, 15_000, `${label} dock`)
  return page.dock()
}

async function liveProcesses(workspace) {
  const runs = await workspace.spawnedRuns()
  return runs.flatMap(run => [run.pid, run.child, run.grandchild]).filter(pid => isAlive(pid))
}

test('1. plan → confirm → run panel keeps a stop button → stop really terminates the process tree', async t => {
  const env = await setup(t)
  const code = await openPlanInDock(env)
  env.page.click('confirm', env.page.dock())

  // While /maa confirm is in flight the panel is already a run panel with stop.
  let dock = await waitDock(env.page, 'run')
  assert.ok(env.page.buttons('stop', dock).length >= 1)

  await waitFor(async () => (await env.workspace.spawnedRuns()).length === 1, 15_000, 'maa run')
  await waitFor(async () => { await env.page.settle(); return /RUN-[A-F0-9]{8}/u.test(env.page.text()) }, 15_000, 'run id bound')
  const [spawned] = await env.workspace.spawnedRuns()
  assert.ok(isAlive(spawned.pid) && isAlive(spawned.child))

  // A status refresh (what used to flip the button into a disabled
  // "正在停止…" because Number(null) is finite) must keep it usable.
  env.page.click('', findButtonByText(env.page, '刷新状态'))
  await env.page.settle(200)
  dock = await waitDock(env.page, 'run')
  const stop = env.page.button('stop', dock)
  assert.equal(stop.props.disabled, false)
  assert.equal(stop.children.join(''), '停止任务')
  const record = (await readRuns(env.workspace))[0]
  assert.equal(record.status, 'running')
  assert.equal(record.stopRequestedAt, null)
  assert.equal(record.confirmationCode, code)
  assert.equal(record.pid, spawned.pid === record.pid ? record.pid : record.pid)

  env.page.click('stop', dock)
  // The very next render (before the host answers) already shows stopping.
  await new Promise(resolve => queueMicrotask(resolve))
  await new Promise(resolve => queueMicrotask(resolve))
  assert.match(env.page.text(), /正在停止/u)
  assert.equal(env.page.button('stop', env.page.dock()).props.disabled, true)
  await waitDock(env.page, 'finished', 'finished after stop')
  assert.equal(isAlive(spawned.pid), false, 'maa process must be gone')
  assert.equal(isAlive(spawned.child), false, 'its child must be gone too')
  const stopped = (await readRuns(env.workspace))[0]
  assert.equal(stopped.status, 'stopped')
  assert.ok(stopped.finishedAt > 0)
  assert.equal(stopped.instructions[0].type, 'stop_now')
  assert.equal(stopped.instructions[0].status, 'completed')
  assert.match(env.page.text(), /最近一次 MAA 执行：已停止/u)
})

function findButtonByText(page, label) {
  // Wrap the matching button so page.click('', scope) finds exactly it.
  const button = page.buttons('').find(node => node.children.join('') === label)
  if (!button) throw new Error(`no button "${label}"`)
  return { type: 'wrap', props: {}, children: [button] }
}

test('2. confirmation and run panels minimize and expand repeatedly without losing anything', async t => {
  const env = await setup(t)
  const code = await openPlanInDock(env)
  const note = env.page.inputs().find(input => input.props.className === 'maa-note-input')
  note.props.onChange({ target: { value: '优先招募维什戴尔' } })
  await env.page.settle()
  const mountsBefore = env.page.mini.mountCount('ConfirmButton')

  for (let round = 0; round < 3; round += 1) {
    env.page.click('toggle', env.page.dock())
    await env.page.settle()
    let dock = env.page.dock()
    assert.equal(dock.props['data-collapsed'], 'true')
    assert.equal(env.page.button('toggle', dock).children.join(''), '+')
    assert.doesNotMatch(env.page.visibleText(), /确认并执行 MAA/u, 'body hidden while minimized')
    assert.ok(env.page.mini.alive('ConfirmButton'), 'minimizing must not unmount the body')
    env.page.click('toggle', dock)
    await env.page.settle()
    dock = env.page.dock()
    assert.equal(dock.props['data-collapsed'], 'false')
    assert.equal(env.page.button('toggle', dock).children.join(''), '−')
    assert.match(env.page.visibleText(), /确认并执行 MAA/u)
    const restored = env.page.inputs().find(input => input.props.className === 'maa-note-input')
    assert.equal(restored.props.value, '优先招募维什戴尔')
  }
  assert.equal(env.page.mini.mountCount('ConfirmButton'), mountsBefore, 'no remount across toggles')

  // Minimized state survives a page refresh, and the + is there to undo it.
  env.page.click('toggle', env.page.dock())
  await env.page.settle()
  const reloaded = loadClient({ host: env.hostRef, localStorage: env.localStorage })
  reloaded.show(SESSION_A)
  let dock = await waitDock(reloaded, 'plan', 'restored plan')
  assert.equal(dock.props['data-collapsed'], 'true')
  reloaded.click('toggle', dock)
  await reloaded.settle()
  assert.match(reloaded.visibleText(), /确认并执行 MAA/u)
  // The unconfirmed edit came back from the per-code draft.
  assert.equal(reloaded.inputs().find(input => input.props.className === 'maa-note-input').props.value, '优先招募维什戴尔')
  assert.match(reloaded.text(), new RegExp(code))
  // Clear the note so confirmation does not require a strategy preview.
  reloaded.inputs().find(input => input.props.className === 'maa-note-input').props.onChange({ target: { value: '' } })
  await reloaded.settle()

  // Run panel: same behaviour, including while the host status changes.
  reloaded.click('confirm', reloaded.dock())
  dock = await waitDock(reloaded, 'run')
  await waitFor(async () => (await env.workspace.spawnedRuns()).length === 1, 15_000, 'maa run')
  for (let round = 0; round < 3; round += 1) {
    reloaded.click('toggle', reloaded.dock())
    await reloaded.settle()
    dock = reloaded.dock()
    assert.equal(dock.props['data-collapsed'], 'true')
    assert.equal(reloaded.button('toggle', dock).children.join(''), '+')
    assert.match(reloaded.visibleText(), /MAA 任务执行中|正在启动/u, 'title stays visible')
    reloaded.click('toggle', dock) // expanding also refreshes the host status once
    await reloaded.settle(150)
    dock = await waitDock(reloaded, 'run')
    assert.equal(dock.props['data-collapsed'], 'false')
    assert.equal(reloaded.button('stop', dock).props.disabled, false)
  }
  const reloadedAgain = loadClient({ host: env.hostRef, localStorage: env.localStorage })
  reloadedAgain.show(SESSION_A)
  dock = await waitDock(reloadedAgain, 'run', 'run after refresh')
  assert.equal(reloadedAgain.button('stop', dock).props.disabled, false)
  reloadedAgain.click('stop', dock)
  await waitDock(reloadedAgain, 'finished')
  assert.deepEqual(await liveProcesses(env.workspace), [], JSON.stringify({ spawned: await env.workspace.spawnedRuns(), runs: (await readRuns(env.workspace)).map(run => [run.id, run.status, run.pid, run.summary]), text: reloadedAgain.text() }))
})

test('3. closing the confirmation panel deletes the plan and the old code stays dead on the host', async t => {
  const env = await setup(t)
  const code = await openPlanInDock(env)
  env.page.click('close', env.page.dock())
  await waitFor(async () => { await env.page.settle(); return env.page.dock()?.props['data-maa-dock'] !== 'plan' }, 10_000, 'plan closed')
  assert.equal(env.page.confirmCalls.length, 1)

  const confirm = await env.hostRef.current.execute(SESSION_A, `/maa confirm ${code}`)
  assert.equal(confirm.kind, 'error')
  assert.match(confirm.text, new RegExp(`${code} 已被取消，已永久失效`))
  // Idempotent close; still dead after a DSH restart (tombstone on disk).
  assert.equal((await env.hostRef.current.execute(SESSION_A, `/maa cancel ${code}`)).kind, 'success')
  env.hostRef.current.kill()
  env.hostRef.current = await env.workspace.startHost()
  const afterRestart = await env.hostRef.current.execute(SESSION_A, `/maa confirm ${code}`)
  assert.equal(afterRestart.kind, 'error')
  assert.match(afterRestart.text, /已被取消/u)
  const peek = await env.hostRef.current.execute(SESSION_A, `/maa peek ${code}`)
  assert.equal(peek.kind, 'error')
  assert.equal((await env.workspace.spawnedRuns()).length, 0, 'nothing was ever executed')
  const stored = JSON.parse(await readFile(path.join(env.workspace.env.DSH_MAA_CLI_STATE_DIR, 'pending-plans.json'), 'utf8'))
  assert.deepEqual(stored.plans, {})
  assert.equal(stored.closed[code].status, 'cancelled')

  // A refused dialog leaves the plan alone.
  const keep = loadClient({ host: env.hostRef, localStorage: createLocalStorage(), confirmAnswer: () => false })
  const second = await preparePlan(env.hostRef)
  keep.show(SESSION_A)
  await waitDock(keep, 'plan')
  keep.click('close', keep.dock())
  await keep.settle(100)
  assert.equal(keep.dock().props['data-maa-dock'], 'plan')
  assert.match((await env.hostRef.current.execute(SESSION_A, `/maa peek ${second}`)).text, new RegExp(second))
})

test('4. closing the run panel stops the real task and waits for it to exit', async t => {
  const env = await setup(t)
  await openPlanInDock(env)
  env.page.click('confirm', env.page.dock())
  await waitDock(env.page, 'run')
  await waitFor(async () => (await env.workspace.spawnedRuns()).length === 1, 15_000, 'maa spawned')
  const [spawned] = await env.workspace.spawnedRuns()

  env.page.click('close', env.page.dock())
  await waitDock(env.page, 'finished')
  assert.equal(env.page.confirmCalls.length, 1)
  assert.match(env.page.confirmCalls[0], /停止当前 MAA 任务/u)
  assert.equal(isAlive(spawned.pid), false)
  assert.equal(isAlive(spawned.child), false)
  const [record] = await readRuns(env.workspace)
  assert.equal(record.status, 'stopped')

  // Closing the finished record afterwards only hides it.
  env.page.click('close', env.page.dock())
  await env.page.settle()
  assert.notEqual(env.page.dock()?.props['data-maa-dock'], 'finished')
})

test('5. repeated stops, repeated closes, and concurrent confirm/cancel/stop are race-free', async t => {
  const env = await setup(t)
  const host = () => env.hostRef.current

  // Concurrent confirm and cancel: exactly one wins, and the loser says why.
  const code = await preparePlan(env.hostRef)
  const [confirmed, cancelled] = await Promise.all([
    host().execute(SESSION_A, `/maa confirm ${code}`),
    host().execute(SESSION_A, `/maa cancel ${code}`),
  ])
  const winners = [confirmed, cancelled].filter(item => item.kind === 'success')
  assert.equal(winners.length, 1, JSON.stringify([confirmed, cancelled]))
  if (confirmed.kind === 'success') {
    assert.match(cancelled.text, /已经确认并/u)
    const runId = confirmed.text.match(/RUN-[A-F0-9]{8}/u)[0]
    // Repeated stop: concurrent and sequential calls share one termination.
    const stops = await Promise.all([
      host().execute(SESSION_A, `/maa stop ${runId}`),
      host().execute(SESSION_A, `/maa stop ${runId}`),
      host().execute(SESSION_A, `/maa stop ${code}`),
    ])
    assert.ok(stops.every(item => item.kind === 'success'), JSON.stringify(stops))
    const again = await host().execute(SESSION_A, `/maa stop ${runId}`)
    assert.equal(again.kind, 'success')
    assert.match(again.text, /无需再次停止/u)
  } else {
    assert.match(confirmed.text, /已被取消|没有待确认/u)
    assert.equal((await env.workspace.spawnedRuns()).length, 0)
  }
  assert.deepEqual(await liveProcesses(env.workspace), [])

  // Stop while the confirmation is still launching: no run survives, and the
  // consumed-or-not code can never run later.
  const launchCode = await preparePlan(env.hostRef)
  const launching = host().execute(SESSION_A, `/maa confirm ${launchCode}`)
  await new Promise(resolve => setTimeout(resolve, 20))
  const early = await host().execute(SESSION_A, `/maa stop ${launchCode}`)
  const launchResult = await launching
  assert.equal(early.kind, 'success', early.text)
  await waitFor(async () => (await liveProcesses(env.workspace)).length === 0, 10_000, 'no process after early stop')
  assert.equal((await host().execute(SESSION_A, `/maa confirm ${launchCode}`)).kind, 'error')
  const runs = await readRuns(env.workspace)
  assert.ok(runs.every(run => run.status !== 'running'), JSON.stringify(runs.map(run => run.status)))
  assert.ok(/已在开始执行前取消|已开始执行|启动阶段被停止/u.test(launchResult.text), launchResult.text)

  // UI: double-clicking stop and close issues one stop; the button locks.
  const plan = await preparePlan(env.hostRef)
  env.page.show(SESSION_A)
  await waitDock(env.page, 'plan')
  assert.match(env.page.text(), new RegExp(plan))
  env.page.click('confirm', env.page.dock())
  await waitDock(env.page, 'run')
  await waitFor(async () => (await readRuns(env.workspace)).some(run => run.status === 'running' && run.pid > 0), 15_000, 'running')
  await waitFor(async () => { await env.page.settle(); return /RUN-[A-F0-9]{8}/u.test(env.page.text()) }, 15_000, 'run id')
  const before = env.hostRef.current.log.filter(entry => /^\/maa stop/u.test(entry.line)).length
  // Grab the handlers of this render, then fire stop, stop again, and close
  // in the same tick — the way a double/triple click arrives.
  const stopButton = env.page.button('stop', env.page.dock())
  const closeButton = env.page.button('close', env.page.dock())
  stopButton.props.onClick()
  stopButton.props.onClick()
  closeButton.props.onClick()
  await new Promise(resolve => queueMicrotask(resolve))
  await new Promise(resolve => queueMicrotask(resolve))
  assert.equal(env.page.button('stop', env.page.dock()).props.disabled, true)
  assert.equal(env.page.button('close', env.page.dock()).props.disabled, true)
  await waitDock(env.page, 'finished')
  const after = env.hostRef.current.log.filter(entry => /^\/maa stop/u.test(entry.line)).length
  assert.equal(after - before, 1)
  assert.deepEqual(await liveProcesses(env.workspace), [])
})

test('6. refresh, another session, and a DSH restart all restore the right controls', async t => {
  const env = await setup(t)
  const code = await preparePlan(env.hostRef)
  const started = await env.hostRef.current.execute(SESSION_A, `/maa confirm ${code}`)
  assert.equal(started.kind, 'success', started.text)
  const runId = started.text.match(/RUN-[A-F0-9]{8}/u)[0]

  // Fresh page (refresh): the dock comes back bound to the run, with stop.
  env.page.show(SESSION_A)
  let dock = await waitDock(env.page, 'run')
  assert.match(env.page.text(), new RegExp(runId))
  assert.equal(env.page.button('stop', dock).props.disabled, false)

  // Another conversation sees the run read-only and cannot stop it.
  env.page.show(SESSION_B)
  dock = await waitDock(env.page, 'observer')
  assert.equal(env.page.buttons('stop', dock).length, 0)
  const foreignStop = await env.hostRef.current.execute(SESSION_B, `/maa stop ${runId}`)
  assert.equal(foreignStop.kind, 'error')
  assert.match(foreignStop.text, /另一个 DSH 会话/u)
  const plainStop = await env.hostRef.current.execute(SESSION_B, '/maa stop')
  assert.equal(plainStop.kind, 'error')
  const [spawned] = await env.workspace.spawnedRuns()
  assert.ok(isAlive(spawned.pid), 'the other session must not have stopped it')
  // Hiding the observer panel does not stop anything either.
  env.page.click('close', dock)
  await env.page.settle(100)
  assert.ok(isAlive(spawned.pid))

  // Back to the owning conversation: the stop control is still there.
  env.page.show(SESSION_A)
  dock = await waitDock(env.page, 'run')
  assert.equal(env.page.button('stop', dock).props.disabled, false)

  // DSH crashes (SIGKILL — no plugin cleanup) while maa keeps running.
  env.hostRef.current.kill()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(isAlive(spawned.pid), 'maa survives the DSH crash, like on Windows')
  env.hostRef.current = await env.workspace.startHost()
  // The restarted plugin reaps exactly the recorded process tree.
  await waitFor(async () => !isAlive(spawned.pid) && !isAlive(spawned.child), 15_000, 'orphan reaped')
  await waitFor(async () => (await readRuns(env.workspace))[0]?.status === 'stopped', 10_000, 'record settled')
  assert.match((await readRuns(env.workspace))[0].summary, /DSH 重启后/u)

  const afterRestart = loadClient({ host: env.hostRef, localStorage: env.localStorage })
  afterRestart.show(SESSION_A)
  dock = await waitDock(afterRestart, 'finished', 'finished after restart')
  assert.match(afterRestart.text(), /已停止/u)
})

test('7. a stop that cannot confirm exit keeps the controls and the reason, and can be retried', { skip: process.platform === 'win32' && 'POSIX-only: needs a grandchild that escapes the process group' }, async t => {
  const env = await setup(t, { mode: 'escape' })
  await openPlanInDock(env)
  env.page.click('confirm', env.page.dock())
  await waitDock(env.page, 'run')
  // The fake records itself only after the escaping grandchild exists.
  await waitFor(async () => (await env.workspace.spawnedRuns()).length === 1, 15_000, 'escaping tree spawned')
  await waitFor(async () => { await env.page.settle(); return /RUN-[A-F0-9]{8}/u.test(env.page.text()) }, 15_000, 'run id')
  const [spawned] = await env.workspace.spawnedRuns()

  env.page.click('stop', env.page.dock())
  // DSH_MAA_STOP_TIMEOUT_MS is 4 s in the harness.
  await waitFor(async () => { await env.page.settle(); return /停止失败/u.test(env.page.text()) }, 15_000, 'stop failure shown')
  let dock = env.page.dock()
  assert.equal(dock.props['data-maa-dock'], 'run')
  assert.equal(env.page.button('stop', dock).props.disabled, false, 'stop stays usable')
  let [record] = await readRuns(env.workspace)
  assert.equal(record.status, 'running')
  assert.equal(record.stopRequestedAt, null)
  assert.match(record.stopError, /没有退出/u)
  assert.ok(isAlive(spawned.grandchild))

  // The escaped process goes away; the retry now completes.
  killQuietly(spawned.grandchild)
  env.page.click('stop', dock)
  await waitDock(env.page, 'finished')
  ;[record] = await readRuns(env.workspace)
  assert.equal(record.status, 'stopped')
  assert.equal(record.stopError, '')
})

test('8. natural-language runtime instructions still work from the run panel', async t => {
  const env = await setup(t)
  const code = await preparePlan(env.hostRef)
  assert.equal((await env.hostRef.current.execute(SESSION_A, `/maa confirm ${code}`)).kind, 'success')
  env.page.show(SESSION_A)
  await waitDock(env.page, 'run')
  const send = async text => {
    const input = env.page.inputs().find(node => /运行时要求/u.test(node.props.placeholder ?? ''))
    input.props.onChange({ target: { value: text } })
    await env.page.settle()
    const form = env.page.tree() && (await import('./helpers/mini-react.mjs')).findAll(env.page.tree(), node => node.type === 'form')[0]
    form.props.onSubmit({ preventDefault() {} })
    await waitFor(async () => { await env.page.settle(); return !env.page.inputs().find(node => /运行时要求/u.test(node.props.placeholder ?? '')).props.disabled }, 10_000, 'instruction answered')
    return env.page.text()
  }
  assert.match(await send('现在打到哪里了'), /"running"/u)
  assert.match(await send('再打两局就停'), /只适用于正在执行的肉鸽任务/u)
  // The other session cannot attach stop conditions to this run.
  const foreign = await env.hostRef.current.execute(SESSION_B, '/maa 这次 Boss 关前停止')
  assert.equal(foreign.kind, 'error')
  assert.match(foreign.text, /另一个 DSH 会话/u)
  // Natural-language "stop now" goes through the same targeted stop.
  const stopNow = await env.hostRef.current.execute(SESSION_A, '/maa 现在停止')
  assert.equal(stopNow.kind, 'success', stopNow.text)
  assert.deepEqual(await liveProcesses(env.workspace), [])
})

test('9. a plan confirmed from the transcript card is controllable from both the card and the dock', async t => {
  const env = await setup(t)
  env.page.show(SESSION_A)
  const code = await preparePlan(env.hostRef)
  env.page.addToolCard(SESSION_A, `MAA 计划待确认 确认码 ${code}`)
  await waitFor(async () => {
    await env.page.settle()
    return env.page.buttons('confirm').length >= 1
  }, 10_000, 'card confirm button')
  const card = (await import('./helpers/mini-react.mjs')).findAll(env.page.tree(), node => node.props?.['data-tool'] === 'maa_prepare_plan')[0]
  env.page.click('confirm', card)
  await waitDock(env.page, 'run')
  await waitFor(async () => (await readRuns(env.workspace)).some(run => run.status === 'running' && run.pid > 0), 15_000, 'running')
  await waitFor(async () => { await env.page.settle(); return /RUN-[A-F0-9]{8}/u.test(env.page.text()) }, 15_000, 'run id')
  // Both surfaces show stop after the confirm command returned.
  const cardNow = (await import('./helpers/mini-react.mjs')).findAll(env.page.tree(), node => node.props?.['data-tool'] === 'maa_prepare_plan')[0]
  assert.equal(env.page.buttons('stop', cardNow).length, 1)
  assert.equal(env.page.buttons('stop', env.page.dock()).length, 1)
  env.page.click('stop', cardNow)
  await waitDock(env.page, 'finished')
  assert.deepEqual(await liveProcesses(env.workspace), [])
})

test('10. two sessions confirming at once: one runs, the other is refused and keeps its plan', async t => {
  const env = await setup(t)
  const codeA = await preparePlan(env.hostRef, SESSION_A)
  const codeB = await preparePlan(env.hostRef, SESSION_B)
  const [a, b] = await Promise.all([
    env.hostRef.current.execute(SESSION_A, `/maa confirm ${codeA}`),
    env.hostRef.current.execute(SESSION_B, `/maa confirm ${codeB}`),
  ])
  const outcomes = [[SESSION_A, codeA, a], [SESSION_B, codeB, b]]
  const winners = outcomes.filter(([, , result]) => result.kind === 'success')
  const losers = outcomes.filter(([, , result]) => result.kind !== 'success')
  assert.equal(winners.length, 1, JSON.stringify([a, b]))
  assert.match(losers[0][2].text, /MAA 任务正在执行中/u)
  // The refused session's code was not consumed: it can run later.
  const peek = await env.hostRef.current.execute(losers[0][0], `/maa peek ${losers[0][1]}`)
  assert.equal(peek.kind, 'success')
  const runId = winners[0][2].text.match(/RUN-[A-F0-9]{8}/u)[0]
  assert.equal((await env.hostRef.current.execute(winners[0][0], `/maa stop ${runId}`)).kind, 'success')
  const later = await env.hostRef.current.execute(losers[0][0], `/maa confirm ${losers[0][1]}`)
  assert.equal(later.kind, 'success', later.text)
  const laterRun = later.text.match(/RUN-[A-F0-9]{8}/u)[0]
  assert.equal((await env.hostRef.current.execute(losers[0][0], `/maa stop ${laterRun}`)).kind, 'success')
  assert.deepEqual(await liveProcesses(env.workspace), [])
})
