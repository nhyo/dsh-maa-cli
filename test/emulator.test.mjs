import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkEmulator, emulatorErrorMessage, MUMU_NOT_RUNNING_MESSAGE, resolveEmulatorEndpoint } from '../src/runtime/emulator.js'

const RESPONSE = stdout => ({ command: 'maa-cli', exitCode: 0, terminationSignal: '', stdout, stderr: '' })

function stubRunMaa(configDir) {
  return async args => {
    if (args[0] !== 'dir' || args[1] !== 'config') throw new Error(`unexpected maa-cli call: ${args.join(' ')}`)
    return RESPONSE(`${configDir}\n`)
  }
}

async function makeConfig(address = '127.0.0.1:16384') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-emulator-'))
  await mkdir(path.join(root, 'profiles'), { recursive: true })
  const lines = ['[connection]', 'adb_path = "X:\\\\Mock\\\\MuMu\\\\nx_main\\\\adb.exe"']
  if (address !== '') lines.push(`address = "${address}"`)
  lines.push('config = "MuMuEmulator12"')
  await writeFile(path.join(root, 'profiles', 'default.toml'), `${lines.join('\n')}\n`, 'utf8')
  return root
}

test('reads the emulator endpoint from the maa-cli config directory', async () => {
  const root = await makeConfig()
  try {
    const resolved = await resolveEmulatorEndpoint({ runMaa: stubRunMaa(root), env: {} })
    assert.equal(resolved.found, true)
    assert.deepEqual(resolved.endpoint, { host: '127.0.0.1', port: 16384 })
    assert.equal(resolved.profile.adbPath, 'X:\\Mock\\MuMu\\nx_main\\adb.exe')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('passes when the ADB port accepts connections', async () => {
  const root = await makeConfig()
  try {
    const result = await checkEmulator({ runMaa: stubRunMaa(root), env: {}, isPortOpen: async () => true })
    assert.equal(result.ok, true)
    assert.equal(result.reason, 'reachable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails with the exact MuMu message when the ADB port is closed', async () => {
  const root = await makeConfig()
  try {
    const result = await checkEmulator({ runMaa: stubRunMaa(root), env: {}, isPortOpen: async () => false })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'port-closed')

    const message = emulatorErrorMessage(result)
    assert.equal(message.split('\n')[0], MUMU_NOT_RUNNING_MESSAGE)
    assert.equal(MUMU_NOT_RUNNING_MESSAGE, '请手动启动mumu模拟器！')
    assert.match(message, /127\.0\.0\.1:16384/)
    assert.match(message, /计划仍然保留/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skips the check when the profile or address is unknown', async () => {
  const noProfile = await checkEmulator({ runMaa: stubRunMaa(''), env: {}, isPortOpen: async () => false })
  assert.equal(noProfile.ok, true)
  assert.equal(noProfile.reason, 'no-profile')

  const throwing = await checkEmulator({ runMaa: async () => { throw new Error('boom') }, env: {}, isPortOpen: async () => false })
  assert.equal(throwing.ok, true)
  assert.equal(throwing.reason, 'no-profile')

  const root = await makeConfig('')
  try {
    const noAddress = await checkEmulator({ runMaa: stubRunMaa(root), env: {}, isPortOpen: async () => false })
    assert.equal(noAddress.ok, true)
    assert.equal(noAddress.reason, 'no-address')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
