// In-process execution state shared by the host modules. These maps are the
// only owners of live runs, workflows, stop requests and launching
// confirmations; every module imports the same instances.
import { isProcessAlive } from '../commands/run-state.js'

export const activeExecutions = new Map()

export const activeRuns = new Map()

export const activeWorkflows = new Map()

export const stopRequests = new Map()

// `/maa confirm` calls that are still between "clicked" and "run started",
// keyed by DSH session. A stop/close during that window aborts the launch.
export const launches = new Map()

export function agentKey(agent) {
  if (!agent || agent.id === undefined) throw new Error('当前命令没有可用的 DSH 会话。')
  return String(agent.id)
}

// Which DSH session may control a run record:
//   self    – this plugin process owns the child and the caller's session started it
//   other   – this plugin process owns it, but another DSH session started it
//   foreign – another live plugin host process owns it (second DSH instance)
//   orphan  – nobody owns it any more (DSH restarted while maa-cli kept running)
export function runOwnership(run, key) {
  if (!run) return 'none'
  if (activeRuns.has(run.id)) return run.sessionId === key ? 'self' : 'other'
  const ownerPid = Number(run.ownerPid)
  if (Number.isInteger(ownerPid) && ownerPid !== process.pid && isProcessAlive(ownerPid)) return 'foreign'
  return 'orphan'
}

export function ownershipRefusal(run, ownership) {
  const label = run.purpose || run.confirmationCode || run.id
  if (ownership === 'other') return `正在执行的 MAA 任务（${label}）属于另一个 DSH 会话；为避免误停，请在发起它的会话里停止。`
  if (ownership === 'foreign') return `正在执行的 MAA 任务（${label}）由另一个仍在运行的 DSH 进程持有，本会话不会终止它。`
  return ''
}
