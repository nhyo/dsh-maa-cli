import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildTaskDocument } from '../src/commands/planner.js'
import { taskPanelFromDocument } from '../src/commands/task-panel.js'
import {
  applyRememberedConfig,
  clearPanelMemory,
  panelMemoryFilePath,
  readPanelMemory,
  rememberPanelValues,
} from '../src/commands/panel-memory.js'

async function tempEnv(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'maa-panel-memory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { DSH_MAA_CLI_STATE_DIR: directory }
}

function roguelikePanel(theme, steps = []) {
  return taskPanelFromDocument(buildTaskDocument([{ type: 'Roguelike', theme, startsCount: 3 }, ...steps]))
}

function scopedOption(panel, key, theme) {
  return panel.fields.find(field => field.key === key).options.find(option => option.when?.in?.includes(theme))
}

test('remembers the confirmed roguelike configuration per theme', async (t) => {
  const env = await tempEnv(t)
  const panel = roguelikePanel('Sarkaz')
  const mode = scopedOption(panel, 'mode', 'Sarkaz')
  const squad = scopedOption(panel, 'squad', 'Sarkaz')
  panel.values = {
    ...panel.values,
    mode: mode.value,
    difficulty: 'MAX',
    startsCount: 12,
    useSupport: true,
    ...(squad ? { squad: squad.value } : {}),
  }

  const key = await rememberPanelValues(panel, { env })
  assert.equal(key, 'Roguelike:Sarkaz')
  assert.match(panelMemoryFilePath(env), /panel-memory\.json$/u)

  const memory = await readPanelMemory(env)
  assert.equal(memory.entries['Roguelike:Sarkaz'].difficulty, 'MAX')
  assert.equal(memory.entries['Roguelike:Sarkaz'].startsCount, 12)
  assert.equal(memory.entries['Roguelike:Sarkaz'].useSupport, true)
  assert.equal(memory.entries['Roguelike:Sarkaz'].theme, undefined)

  const fresh = roguelikePanel('Sarkaz')
  const applied = await applyRememberedConfig(fresh, { env })
  assert.equal(applied.remembered, true)
  assert.equal(applied.values.difficulty, 'MAX')
  assert.equal(applied.values.startsCount, 12)
  assert.equal(applied.values.useSupport, true)
  assert.equal(applied.values.mode, mode.value)
  // The caller's panel object is not mutated in place.
  assert.equal(fresh.values.startsCount, 9999)
})

test('keeps remembered settings scoped to the theme that stored them', async (t) => {
  const env = await tempEnv(t)
  const panel = roguelikePanel('Sarkaz')
  panel.values = { ...panel.values, startsCount: 42 }
  await rememberPanelValues(panel, { env })

  const other = await applyRememberedConfig(roguelikePanel('BlackFlow'), { env })
  assert.equal(other.remembered, undefined)
  assert.equal(other.values.startsCount, 9999)
})

test('skips remembered values the current capabilities no longer accept', async (t) => {
  const env = await tempEnv(t)
  const panel = roguelikePanel('Sarkaz')
  // 999 is a storable number but no longer a selectable difficulty, so the
  // panel must fall back to its own default instead of passing it through.
  panel.values = { ...panel.values, difficulty: 999, startsCount: 0, useSupport: 'yes' }
  await rememberPanelValues(panel, { env })

  const applied = await applyRememberedConfig(roguelikePanel('Sarkaz'), { env })
  assert.equal(applied.values.difficulty !== 999, true)
  assert.equal(applied.values.startsCount, 9999)
  assert.equal(applied.values.useSupport !== 'yes', true)
})

test('clears the remembered panel configuration', async (t) => {
  const env = await tempEnv(t)
  const panel = roguelikePanel('Sarkaz')
  panel.values = { ...panel.values, startsCount: 5 }
  await rememberPanelValues(panel, { env })
  await clearPanelMemory(env)
  assert.deepEqual((await readPanelMemory(env)).entries, {})
})

test('does not remember non-roguelike panels', async (t) => {
  const env = await tempEnv(t)
  const panel = taskPanelFromDocument(buildTaskDocument([{ type: 'Fight', stage: '1-7', times: 1 }]))
  assert.equal(await rememberPanelValues(panel, { env }), null)
  // Fight panels keep the plan-provided values; only roguelike settings are
  // remembered across plans, so a `/maa fight 1-7` never inherits another stage.
  const applied = await applyRememberedConfig(panel, { env })
  assert.equal(applied.values.stage, '1-7')
  assert.deepEqual((await readPanelMemory(env)).entries, {})
})
