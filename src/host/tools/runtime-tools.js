// Environment check and private-runtime management tools.
import { DOCTOR_RESULT_SCHEMA, renderResult, RUNTIME_RESULT_SCHEMA } from '../tool-schemas.js'
import { formatReport, runDoctor } from '../../runtime/doctor.js'
import { runMaa } from '../../runtime/runner.js'
import { bootstrapRuntime, formatRuntimeReport, inspectRuntime, updateManifest, updateRuntime } from '../../runtime/runtime.js'
import { activeExecutions } from '../execution-state.js'

export function registerRuntimeTools(ctx) {
  ctx.tools.register({
    name: 'maa_doctor',
    description: 'Read-only environment health check for the local MAA setup: resolves maa-cli/Core versions and directories, proves the cache and config directories accept atomic temp-file renames (the EFS-encryption failure mode), verifies the MaaResource hot-update checkout, and checks the ADB binary, ADB port, and MuMu manager from the saved profile. Never starts the emulator, never connects to the game, and never modifies the game. Run it before a first game action or whenever a maa-cli command fails.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: DOCTOR_RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: formatReport(value) }] },
    async execute(_args, exec) { return await runDoctor({ runMaa, signal: exec.signal }) },
    presentCall: () => ({ card: 'terminal', title: 'MAA 环境体检' }),
  })

  ctx.tools.register({
    name: 'maa_runtime',
    description: 'Inspect or bootstrap the plugin-private MAA runtime, so the plugin works on a machine that never installed MAA. Actions: status (is maa-cli/MaaCore/resources ready, and where), install (download maa-cli from its GitHub release, then run `maa-cli install --batch` so maa-cli fetches the matching MaaCore build and resources into the runtime directory; roughly 250-450 MB and several minutes on a slow link), update (refresh MaaCore and resources). Everything lives under ~/.dsh/maa-cli/runtime (override with DSH_MAA_CLI_RUNTIME_DIR) and is isolated from any global MAA installation through MAA_DATA_DIR/MAA_STATE_DIR/MAA_CACHE_DIR/MAA_CONFIG_DIR. Never operates the game.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'install', 'update'] },
        force: { type: 'boolean', description: 'install: reinstall even when the runtime already looks complete.' },
        keepCaches: { type: 'boolean', description: 'install: keep the downloaded MaaCore archive (a few hundred MB) instead of deleting it after a successful install.' },
      },
    },
    output: { schema: RUNTIME_RESULT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      if (args.action === 'status') {
        const status = await inspectRuntime()
        return { action: 'status', installed: status.installed, summary: formatRuntimeReport(status), steps: [] }
      }
      if (args.action === 'update') {
        if (activeExecutions.size > 0) throw new Error('当前有 MAA 任务正在执行，暂不更新；任务结束后再试。')
        const updated = await updateRuntime({ run: runMaa, signal: exec.signal })
        const checkedAt = new Date().toISOString()
        if (updated.result.exitCode !== 0) {
          const detail = updated.result.stderr || updated.result.stdout || `exit ${updated.result.exitCode}`
          await updateManifest(updated.layout, { lastAutoUpdateCheckAt: checkedAt, lastAutoUpdateError: detail })
          throw new Error(`MAA 更新失败，原运行时继续保留：${detail}`)
        }
        await updateManifest(updated.layout, { lastAutoUpdateCheckAt: checkedAt, lastAutoUpdateSuccessAt: checkedAt, lastAutoUpdateError: '' })
        const status = await inspectRuntime()
        return {
          action: 'update', installed: status.installed, summary: formatRuntimeReport(status),
          steps: [{ id: 'update', detail: `maa-cli update 退出码 ${updated.result.exitCode}` }],
        }
      }
      const steps = []
      await bootstrapRuntime({
        run: runMaa,
        signal: exec.signal,
        force: args.force === true,
        keepCaches: args.keepCaches === true,
        onStep: (id, detail) => steps.push({ id, detail }),
      })
      const status = await inspectRuntime()
      return { action: 'install', installed: status.installed, summary: formatRuntimeReport(status), steps }
    },
    presentCall: args => ({ card: 'terminal', title: `MAA 运行时 ${args.action}` }),
  })
}
