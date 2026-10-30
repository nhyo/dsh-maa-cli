import { ensureDirectory, resolveEffectivePath } from './paths.js'
import { queryArguments, runMaa } from './runner.js'

export const PREFLIGHT_DIR_QUERIES = Object.freeze({
  cache: 'cache_dir',
  config: 'config_dir',
  data: 'data_dir',
  hotUpdate: 'hot_update_dir',
})

/**
 * maa-cli creates the directories it writes to, but on a packaged desktop app
 * a redirected AppData path only becomes visible to later directory lookups
 * after something writes through it. Pre-creating the four writable
 * directories turns that first-run hazard into a no-op and also repairs a
 * profile whose directory was never materialised.
 *
 * Best effort by design: a failing `dir` query just skips that entry, because
 * the run itself is the authoritative check.
 */
export async function prepareRuntimeDirectories(options = {}) {
  const runMaaImpl = options.runMaa ?? runMaa
  const env = options.env ?? process.env
  const results = []

  for (const [key, operation] of Object.entries(PREFLIGHT_DIR_QUERIES)) {
    let reported = ''
    try {
      const result = await runMaaImpl(queryArguments(operation), { signal: options.signal, timeoutMs: 20_000 })
      reported = result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/).pop().trim() : ''
    } catch {
      reported = ''
    }
    if (reported === '') {
      results.push({ key, resolved: false, path: '', created: false })
      continue
    }
    const found = await resolveEffectivePath(reported, env)
    const target = found.exists ? found.path : reported
    const ensured = await ensureDirectory(target)
    results.push({
      key,
      resolved: true,
      path: ensured.path,
      created: ensured.created,
      redirectedFrom: found.redirectedFrom,
      error: ensured.error ?? '',
    })
  }
  return results
}

export function summarizePreflight(results) {
  return results
    .filter(result => result.resolved)
    .map(result => `${result.key}: ${result.path}${result.created ? '（已创建）' : ''}`)
    .join('；')
}
