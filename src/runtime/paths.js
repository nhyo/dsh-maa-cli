import { lstat, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

const ENVIRONMENT_PATTERN = /%([^%]+)%/g

/**
 * Expand `%NAME%` references the way cmd.exe and maa-cli's directory helpers
 * do. Unknown names are left untouched so an unset variable never silently
 * becomes an empty path segment.
 */
export function expandEnvironment(value, env = process.env) {
  if (typeof value !== 'string') return ''
  return value.replace(ENVIRONMENT_PATTERN, (match, name) => {
    const direct = env[name]
    if (direct !== undefined) return direct
    const upper = env[name.toUpperCase()]
    return upper !== undefined ? upper : match
  }).trim()
}

export function isInsidePath(candidate, parent) {
  const target = path.resolve(candidate).toLowerCase()
  const root = path.resolve(parent).toLowerCase()
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return target.startsWith(prefix)
}

/**
 * Programs launched from an MSIX/packaged app (the DSH desktop shell is one)
 * are subject to "AppData redirection": paths under `%APPDATA%` and
 * `%LOCALAPPDATA%` are remapped under
 * `<LOCALAPPDATA>\Packages\<package>\LocalCache\{Local,Roaming}`. Directory
 * lookups can therefore fail momentarily for a path that file I/O already
 * resolves, so every derived maa-cli directory is checked in both views.
 *
 * The mapping is derived from the environment and from `Packages\*`, never
 * from a hard-coded package identifier, so it works on any machine that uses
 * packaged-app redirection and does nothing on machines that do not.
 */
export async function packagedAppCandidates(target, env = process.env) {
  const localAppData = expandEnvironment('%LOCALAPPDATA%', env)
  const appData = expandEnvironment('%APPDATA%', env)
  if (localAppData === '') return []

  const mappings = []
  if (appData !== '' && isInsidePath(target, appData)) {
    mappings.push({ base: appData, bucket: 'Roaming', tail: path.relative(appData, target) })
  }
  if (isInsidePath(target, localAppData)) {
    mappings.push({ base: localAppData, bucket: 'Local', tail: path.relative(localAppData, target) })
  }
  if (mappings.length === 0) return []

  const packagesRoot = path.join(localAppData, 'Packages')
  let packages = []
  try {
    packages = await readdir(packagesRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const candidates = []
  for (const mapping of mappings) {
    for (const entry of packages) {
      if (!entry.isDirectory()) continue
      const cacheRoot = path.join(packagesRoot, entry.name, 'LocalCache')
      for (const bucket of [mapping.bucket, mapping.bucket === 'Local' ? 'Roaming' : 'Local']) {
        const candidate = path.join(cacheRoot, bucket, mapping.tail)
        if (!candidates.includes(candidate)) candidates.push(candidate)
      }
    }
  }
  return candidates
}

/**
 * Resolve a directory/file that maa-cli reported, following packaged-app
 * redirection when the literal path is not (yet) visible.
 *
 * Returns `{ path, exists, redirectedFrom }`: `path` is always usable in
 * messages, `redirectedFrom` is set when the real location differs.
 */
export async function resolveEffectivePath(target, env = process.env) {
  const literal = path.resolve(expandEnvironment(target, env))
  if (await exists(literal)) return { path: literal, exists: true, redirectedFrom: null }

  for (const candidate of await packagedAppCandidates(literal, env)) {
    if (await exists(candidate)) return { path: candidate, exists: true, redirectedFrom: literal }
  }
  return { path: literal, exists: false, redirectedFrom: null }
}

export async function exists(target) {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Creating a directory is what makes the packaged-app view materialise a path
 * for later directory lookups, so callers run this before trusting a probe.
 */
export async function ensureDirectory(target) {
  const resolved = path.resolve(expandEnvironment(target))
  const existed = await exists(resolved)
  try {
    await mkdir(resolved, { recursive: true })
    return { path: resolved, created: !existed }
  } catch (error) {
    return { path: resolved, created: false, error: error?.code ?? String(error) }
  }
}
