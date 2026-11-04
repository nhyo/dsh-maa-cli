// Capability, strategy-memory and note-preview context used while preparing plans.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectMaaCompatibility, requireMaaCli } from '../runtime/maa-cli.js'
import { queryArguments, runMaa } from '../runtime/runner.js'
import { discoverMaaCapabilities } from '../capabilities/discovery.js'
import { loadItemIndex } from '../operators/depot.js'
import { applyTaskPanelOverrides, resolveItemId, taskPanelFromDocument } from '../commands/task-panel.js'
import { readPlanningData, weeklyStageOpen } from '../agent/planning-data.js'
import { compileStrategyRequest, GENERATED_COPILOT_MARKER, previewStrategyDetails } from '../strategy/compiler.js'
import { rememberPanelValues } from '../commands/panel-memory.js'
import { decodeConfirmationNote } from './formatting.js'
import { peekPendingPlan, updatePendingPlan } from '../commands/confirmation.js'
import { noteModelPrompt, parseStrategyNote } from '../strategy/note.js'
import { applyStrategyMemory } from '../strategy/memory.js'
import { buildTaskDocument, summarizePlan } from '../commands/planner.js'

export function memoryFallback(error, rejected = 0) {
  return { reused: 0, stored: 0, rejected, categories: [], error: error instanceof Error ? error.message : String(error) }
}

export function memorySummary(memory) {
  if (memory.error) return `｜策略记忆未更新：${memory.error}`
  return `｜策略记忆：复用 ${memory.reused}，新增 ${memory.stored}${memory.rejected ? `，拒绝 ${memory.rejected}` : ''}`
}

export async function strategyEnvironment(signal) {
  const cliPath = await requireMaaCli()
  const [directory, compatibility] = await Promise.all([
    runMaa(queryArguments('resource_dir'), { cliPath, signal, timeoutMs: 30_000 }),
    inspectMaaCompatibility(cliPath, signal),
  ])
  const resourceDir = directory.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
  if (directory.exitCode !== 0 || !resourceDir) throw new Error(`无法读取 MAA 资源目录：${directory.stderr || directory.stdout || `exit ${directory.exitCode}`}`)
  const [capabilities, itemIndex] = await Promise.all([
    discoverMaaCapabilities({ resourceDir, compatibility }),
    loadItemIndex(resourceDir).catch(() => null),
  ])
  return { resourceDir, compatibility, capabilities, itemIndex }
}

// Panel fields that need MAA resource data (item names for drop targets).
export function panelContext(environment) { return { itemIndex: environment?.itemIndex ?? null } }

// Fight drop targets arrive from the model as item names or ids; MaaCore needs
// ids from item_index.json. Unknown names are rejected, never guessed.
export function resolveStepDrops(steps, itemIndex) {
  return steps.map(step => {
    if (step?.type !== 'Fight' || step.drops === undefined) return step
    if (step.drops === null || typeof step.drops !== 'object' || Array.isArray(step.drops)) throw new Error('Fight.drops 必须是“物品名或 ID → 数量”的对象。')
    const drops = {}
    for (const [key, count] of Object.entries(step.drops)) {
      const id = resolveItemId(key, itemIndex)
      drops[id] = (drops[id] ?? 0) + count
    }
    return { ...step, drops }
  })
}

// Warn (do not block) when a weekly resource/chip stage is closed today
// according to the cached game data. Without a cache nothing is claimed.
export async function weeklyStageWarnings(steps, resourceDir) {
  const codes = [...new Set(steps.filter(step => step?.type === 'Fight' && typeof step.stage === 'string').map(step => step.stage.trim()))]
  if (codes.length === 0) return []
  const data = await readPlanningData()
  if (!data?.weekly) return []
  const stages = await readMaaStages(resourceDir)
  const warnings = []
  for (const code of codes) {
    const zone = weeklyStageOpen(data, stages, code, { server: data.server })
    if (zone && zone.openToday === false) warnings.push(`${code}（${zone.name}）今天（${WEEKDAY_LABELS[zone.weekday]}）未开放，开放日：${zone.daysOfWeek.map(day => WEEKDAY_LABELS[day]).join('、')}`)
  }
  return warnings
}

export const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

export async function readMaaStages(resourceDir) {
  return await readFile(path.join(resourceDir, 'stages.json'), 'utf8').then(JSON.parse).catch(() => [])
}

export function documentWithNoteStrategy(document, strategy) {
  if (strategy.kind === 'Roguelike') return structuredClone(document)
  const result = structuredClone(document)
  let replaced = false
  result.tasks = result.tasks.map(task => {
    if (replaced || !['Fight', 'Copilot'].includes(task?.type)) return task
    replaced = true
    return { type: 'Copilot', params: { filename: GENERATED_COPILOT_MARKER, formation: strategy.formation } }
  })
  if (!replaced) throw new Error('当前计划没有可替换为 Copilot 的作战任务。')
  return result
}

export function roguelikeThemeOf(document) {
  const task = (document?.tasks ?? []).find(item => item?.type === 'Roguelike')
  return typeof task?.params?.theme === 'string' ? task.params.theme : ''
}

export async function rememberConfirmedPanel(document, environment) {
  const tasks = Array.isArray(document?.tasks) ? document.tasks : []
  if (tasks.length === 0) return
  const hasRoguelike = tasks.some(task => task?.type === 'Roguelike')
  const capabilities = hasRoguelike
    ? environment?.capabilities ?? (await strategyEnvironment()).capabilities
    : undefined
  await rememberPanelValues(taskPanelFromDocument(document, capabilities, panelContext(environment)))
}

export async function prepareNotePreview(agent, confirmationCode, rawNote, overrides, signal) {
  const note = decodeConfirmationNote(rawNote)
  const pending = await peekPendingPlan(agent)
  if (pending.confirmationCode !== confirmationCode) throw new Error('MAA 确认码与待确认计划不一致。')
  const environment = await strategyEnvironment(signal)
  const patch = Object.keys(overrides ?? {}).length ? applyTaskPanelOverrides(pending.document, overrides, environment.capabilities, panelContext(environment)) : null
  const previewPending = patch ? { ...pending, document: patch.document } : pending
  const parsed = await parseStrategyNote(note, previewPending)
  if (parsed.needsModel) {
    return {
      status: 'needs_model', note, recognized: parsed.recognized, unresolved: parsed.unresolved,
      modelPrompt: noteModelPrompt(parsed),
    }
  }
  const compiled = compileStrategyRequest(parsed.input)
  const applied = await applyStrategyMemory(compiled, { ...environment, persist: false })
  const details = await previewStrategyDetails(applied.strategy, environment.resourceDir)
  // A note may switch the roguelike theme. Rebuild the task chain for the new
  // theme instead of cloning the old plan, and keep the plan title in step with
  // it: the dock must never say one theme while MAA runs another.
  const noteTheme = applied.strategy.kind === 'Roguelike' ? applied.strategy.step?.theme ?? '' : ''
  const themeShifted = noteTheme !== '' && noteTheme !== roguelikeThemeOf(previewPending.document)
  const document = themeShifted
    ? buildTaskDocument([applied.strategy.step], environment.capabilities)
    : documentWithNoteStrategy(previewPending.document, applied.strategy)
  if (themeShifted) details.supported.unshift(`按备注切换到主题 ${noteTheme}，任务链已按该主题重建`)
  if (applied.strategy.kind === 'Copilot') {
    details.changes.unshift({ kind: 'task', target: 'MAA task chain', detail: `Fight → Copilot (${applied.strategy.stageName})` })
  }
  const preview = {
    status: 'ready', note, recognized: parsed.recognized,
    supported: details.supported, unsupported: details.unsupported, changes: details.changes,
    memory: applied.memory, strategy: applied.strategy, document,
    overrides: overrides ?? {}, adjustments: patch?.applied ?? [],
  }
  await updatePendingPlan(agent, current => ({
    ...current,
    ...(themeShifted ? { purpose: summarizePlan([applied.strategy.step], environment.capabilities) } : {}),
    notePreview: preview,
  }))
  return preview
}

export function publicNotePreview(preview) {
  if (!preview) return null
  const { strategy: _strategy, document: _document, ...publicValue } = preview
  return publicValue
}
