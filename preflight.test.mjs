import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PREFLIGHT_DIR_QUERIES, prepareRuntimeDirectories, summarizePreflight } from './preflight.js'
import { exists } from './paths.js'

const RESPONSE = stdout => ({ command: 'maa-cli', exitCode: 0, terminationSignal: '', stdout, stderr: '' })

function stubRunMaa(directories) {
  return async args => {
    if (args[0] !== 'dir') throw new Error(`unexpected maa-cli call: ${args.join(' ')}`)
    return RESPONSE(`${directories[args[1]] ?? ''}\n`)
  }
}

test('queries the four writable maa-cli directories', () => {
  assert.deepEqual(PREFLIGHT_DIR_QUERIES, {
    cache: 'cache_dir',
    config: 'config_dir',
    data: 'data_dir',
    hotUpdate: 'hot_update_dir',
  })
})

test('creates missing directories and reports what changed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-preflight-'))
  const dirs = {
    cache: path.join(root, 'cache'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    'hot-update': path.join(root, 'hot-update'),
  }
  try {
    const results = await prepareRuntimeDirectories({ runMaa: stubRunMaa(dirs), env: {} })
    assert.deepEqual(results.map(result => result.key), ['cache', 'config', 'data', 'hotUpdate'])
    for (const result of results) {
      assert.equal(result.resolved, true)
      assert.equal(result.created, true)
      assert.equal(await exists(result.path), true)
    }
    assert.match(summarizePreflight(results), /（已创建）/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('leaves existing directories untouched and skips unresolved ones', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-preflight-'))
  const cache = path.join(root, 'cache')
  try {
    await mkdir(cache, { recursive: true })
    const results = await prepareRuntimeDirectories({ runMaa: stubRunMaa({ cache }), env: {} })
    const byKey = Object.fromEntries(results.map(result => [result.key, result]))
    assert.equal(byKey.cache.created, false)
    assert.equal(byKey.config.resolved, false)
    assert.equal(byKey.config.path, '')
    assert.doesNotMatch(summarizePreflight(results), /config/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('survives a maa-cli query that throws', async () => {
  const results = await prepareRuntimeDirectories({
    runMaa: async () => { throw new Error('boom') },
    env: {},
  })
  assert.equal(results.length, 4)
  assert.deepEqual(results.map(result => result.resolved), [false, false, false, false])
  assert.equal(summarizePreflight(results), '')
})
