import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ensureDirectory,
  exists,
  expandEnvironment,
  isInsidePath,
  packagedAppCandidates,
  resolveEffectivePath,
} from './paths.js'

test('expands %NAME% references and keeps unknown names intact', () => {
  assert.equal(expandEnvironment('%AAA%\\x', { AAA: 'C:\\a' }), 'C:\\a\\x')
  assert.equal(expandEnvironment('%missing%\\x', {}), '%missing%\\x')
  assert.equal(expandEnvironment('  plain  ', {}), 'plain')
  assert.equal(expandEnvironment(undefined, {}), '')
})

test('detects containment without matching sibling prefixes', () => {
  assert.equal(isInsidePath('C:\\a\\b\\c', 'C:\\a'), true)
  assert.equal(isInsidePath('C:\\a', 'C:\\a'), true)
  assert.equal(isInsidePath('C:\\ab\\c', 'C:\\a'), false)
  assert.equal(isInsidePath('C:\\a', 'C:\\a\\b'), false)
})

test('derives packaged-app redirection candidates only for AppData paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-paths-'))
  const env = { LOCALAPPDATA: path.join(root, 'Local'), APPDATA: path.join(root, 'Roaming') }
  try {
    await mkdir(path.join(root, 'Local', 'Packages', 'Vendor.App_1', 'LocalCache'), { recursive: true })
    await mkdir(path.join(root, 'Local', 'Packages', 'Other.App_2', 'LocalCache'), { recursive: true })

    const inside = await packagedAppCandidates(path.join(root, 'Local', 'loong', 'maa'), env)
    assert.equal(inside.length, 4)
    assert.ok(inside.includes(path.join(root, 'Local', 'Packages', 'Vendor.App_1', 'LocalCache', 'Local', 'loong', 'maa')))
    assert.ok(inside.includes(path.join(root, 'Local', 'Packages', 'Vendor.App_1', 'LocalCache', 'Roaming', 'loong', 'maa')))

    const outside = await packagedAppCandidates(path.join(root, 'elsewhere', 'maa'), env)
    assert.deepEqual(outside, [])
    assert.deepEqual(await packagedAppCandidates(path.join(root, 'Local', 'x'), {}), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves a literal AppData path through the packaged LocalCache view', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-redirect-'))
  const env = { LOCALAPPDATA: path.join(root, 'Local'), APPDATA: path.join(root, 'Roaming') }
  const cacheRoot = path.join(root, 'Local', 'Packages', 'Vendor.App_1', 'LocalCache', 'Local')
  const roamingRoot = path.join(root, 'Local', 'Packages', 'Vendor.App_1', 'LocalCache', 'Roaming')
  try {
    await mkdir(path.join(cacheRoot, 'loong', 'maa', 'cache'), { recursive: true })
    await mkdir(path.join(roamingRoot, 'loong', 'maa', 'config'), { recursive: true })

    const cacheLiteral = path.join(env.LOCALAPPDATA, 'loong', 'maa', 'cache')
    const cache = await resolveEffectivePath(cacheLiteral, env)
    assert.equal(cache.exists, true)
    assert.equal(cache.redirectedFrom, cacheLiteral)
    assert.equal(cache.path, path.join(cacheRoot, 'loong', 'maa', 'cache'))

    const configLiteral = path.join(env.APPDATA, 'loong', 'maa', 'config')
    const config = await resolveEffectivePath(configLiteral, env)
    assert.equal(config.exists, true)
    assert.equal(config.path, path.join(roamingRoot, 'loong', 'maa', 'config'))

    const missing = await resolveEffectivePath(path.join(env.LOCALAPPDATA, 'loong', 'absent'), env)
    assert.equal(missing.exists, false)
    assert.equal(missing.redirectedFrom, null)
    assert.equal(missing.path, path.join(env.LOCALAPPDATA, 'loong', 'absent'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('creates directories and reports whether they were new', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-mkdir-'))
  try {
    const target = path.join(root, 'a', 'b', 'c')
    assert.equal(await exists(target), false)

    const first = await ensureDirectory(target)
    assert.deepEqual({ path: first.path, created: first.created }, { path: path.resolve(target), created: true })
    assert.equal(await exists(target), true)

    const second = await ensureDirectory(target)
    assert.equal(second.created, false)

    await writeFile(path.join(target, 'file.txt'), 'x', 'utf8')
    assert.equal(await exists(path.join(target, 'file.txt')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
