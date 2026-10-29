import { bootstrapRuntime, inspectRuntime, formatRuntimeReport, runtimeLayout } from '../runtime.js'
import { runMaa } from '../runner.js'

const started = Date.now()
try {
  const result = await bootstrapRuntime({
    run: runMaa,
    onStep: (id, detail) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${id}: ${detail}`),
  })
  console.log('installed:', result.installed, 'reclaimed:', result.reclaimed ?? 0)
  console.log(formatRuntimeReport(await inspectRuntime()))
} catch (error) {
  console.error('FAILED:', error?.message ?? error)
  process.exitCode = 1
}
console.log('root:', runtimeLayout().root)
