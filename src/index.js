import { recoverAfterRestart, sessionRunStatus } from './host/run-control.js'
import { createStatusRpcRoute, recordStatusRpcRegistration, STATUS_RPC_CHANNEL } from './commands/status-rpc.js'
import { registerMaaCommand } from './host/maa-command.js'
import { registerStatusTools } from './host/tools/status-tools.js'
import { registerPlanningTools } from './host/tools/planning-tools.js'
import { registerFeatureTools } from './host/tools/feature-tools.js'
import { registerRuntimeTools } from './host/tools/runtime-tools.js'

export const name = 'maa-cli-tools'
export const inject = ['tools', 'commands']
let restartRecoveryPromise = null

export function apply(ctx) {
  // A new plugin process cannot prove that an in-flight step completed. Audit
  // persisted state immediately and clean only this plugin's generated task.
  if (restartRecoveryPromise === null) restartRecoveryPromise = recoverAfterRestart().catch(() => null)
  // The Connection service is optional (absent in headless profiles and older
  // hosts): wait for it locally instead of delaying the whole plugin behind it.
  // `rpc.handle` registers through the web server, so both must be present.
  // Every step is recorded in status-rpc.json, so whether this host process
  // registered the channel (and where it stopped if not) can be read from disk.
  void recordStatusRpcRegistration({ stage: 'applied', hasInject: typeof ctx.inject === 'function' }).catch(() => {})
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['connection', 'webServer'], scoped => {
        try {
          const register = () => scoped.webServer.register({
            kind: 'prefix',
            path: STATUS_RPC_CHANNEL,
            handler: createStatusRpcRoute({
              readStatus: session => sessionRunStatus({ id: session, session: {} }),
              connection: () => scoped.connection,
            }),
          })
          if (typeof scoped.effect === 'function') scoped.effect(register, 'dsh-maa-cli: status rpc route')
          else register()
          void recordStatusRpcRegistration({ stage: 'registered' }).catch(() => {})
        } catch (error) {
          void recordStatusRpcRegistration({ stage: 'register-failed', error: error instanceof Error ? error.message : String(error) }).catch(() => {})
        }
      })
    } catch (error) {
      void recordStatusRpcRegistration({ stage: 'inject-failed', error: error instanceof Error ? error.message : String(error) }).catch(() => {})
    }
  }
  registerMaaCommand(ctx)
  registerStatusTools(ctx)
  registerPlanningTools(ctx)
  registerFeatureTools(ctx)
  registerRuntimeTools(ctx)
}

// Kept importable from the entry for existing callers and tests.
export { classifyMaaExecution, decodeConfirmationNote } from './host/formatting.js'
export { COPILOT_MAX_SWITCHES, createCopilotFallback, pickCopilotFallbacks, runFinishedNotification } from './host/execution.js'
