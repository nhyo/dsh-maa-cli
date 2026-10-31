import { resolveRoguelikeTheme } from './planner.js'
import { parseRuntimeInstruction } from './runtime-instructions.js'

const HELP = [
  'MAA 零模型任务（输入项目名后在确认面板修改参数，不会立即操作游戏）：',
  '/maa startup      开始唤醒',
  '/maa fight        理智作战（也接受 flight / 作战）',
  '/maa infrast      基建换班',
  '/maa recruit      自动公招',
  '/maa mall         信用收支',
  '/maa award        领取奖励',
  '/maa rouge        自动肉鸽',
  '/maa reclamation  生息演算',
  '/maa update       更新干员 Box / 仓库数据',
  '/maa closedown    关闭游戏',
  '',
  '兼容旧写法：/maa fight 1-7 2、/maa rouge 萨米 3；它们也只会预填面板，不会直接执行。',
  '/maa stop         或  /maa 停止任务（也会清理 DSH 重启后残留的 maa-cli 进程）',
  '/maa status       查看当前执行中的任务与最近几次执行记录（面板内部使用）',
  '/maa 这把肉鸽打完就停 / 第五层 Boss 前停止 / 再打两局就停',
  '/maa 取消刚才的停止要求 / 现在打到哪里了',
  '/maa confirm MAA-XXXXXX  确认并执行待确认计划（参数由面板自动附加）',
  '                  末尾也可加 note=<URL 编码的备注>，备注必须先在面板完成策略预览',
  '/maa peek MAA-XXXXXX     只读查看待确认计划的摘要与参数（面板内部使用，不会执行）',
  '/maa note-preview MAA-XXXXXX note=<URL 编码>  编译备注并更新预览，不执行',
  '/maa strategies          查看策略记忆；strategy-enable / disable / delete <id> 管理条目',
  '/maa setup        安装本机 MAA 运行时（首次使用）',
  '',
  '所有项目都必须在面板点击「确认并执行 MAA」后才会运行。',
].join('\n')

const CHINESE_COUNT = new Map([['一', 1], ['两', 2], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10]])

function countOf(value) {
  if (/^\d+$/.test(value)) return Number(value)
  return CHINESE_COUNT.get(value)
}

// The confirmation panel appends its roguelike choices as `key=value` tokens,
// e.g. `/maa confirm MAA-1A2B3C theme=Sarkaz startsCount=3`. Values stay strings
// here; planner.js validates and coerces them against the allowed task fields.
function parseOverrides(raw) {
  if (!raw || raw.trim() === '') return {}
  const overrides = {}
  for (const token of raw.trim().split(/\s+/u)) {
    const index = token.indexOf('=')
    if (index <= 0) {
      throw new Error(`无法识别的确认参数：${token}（应为 key=value，例如 theme=Sarkaz）\n\n${HELP}`)
    }
    const key = token.slice(0, index)
    const value = token.slice(index + 1).replace(/^["']|["']$/g, '')
    overrides[key] = value
  }
  return overrides
}

export function parseLocalMaaCommand(rawInput) {
  const input = String(rawInput ?? '').trim()
  if (input === '' || /^(?:help|帮助|\?)$/iu.test(input)) return { kind: 'help', text: HELP }

  const notePreview = input.match(/^note-preview\s+(MAA-[A-F0-9]{6})(?:\s+(.+))$/iu)
  if (notePreview) {
    const overrides = parseOverrides(notePreview[2])
    if (overrides.note === undefined) throw new Error('备注预览缺少 note=<URL 编码的备注>。')
    const note = overrides.note
    delete overrides.note
    return { kind: 'note-preview', confirmationCode: notePreview[1].toUpperCase(), note, overrides }
  }
  if (/^(?:strategies|策略记忆|策略库)$/iu.test(input)) return { kind: 'strategies' }
  const strategyAction = input.match(/^(strategy-enable|strategy-disable|strategy-delete)\s+([0-9a-f-]{36})$/iu)
  if (strategyAction) return { kind: strategyAction[1].toLowerCase(), id: strategyAction[2].toLowerCase() }
  const confirm = input.match(/^confirm\s+(MAA-[A-F0-9]{6})(?:\s+(.+))?$/iu)
  if (confirm) return { kind: 'confirm', confirmationCode: confirm[1].toUpperCase(), overrides: parseOverrides(confirm[2]) }
  const peek = input.match(/^(?:peek|查看计划)\s*(MAA-[A-F0-9]{6})?$/iu)
  if (peek) return { kind: 'peek', confirmationCode: peek[1] ? peek[1].toUpperCase() : '' }
  if (/^(?:stop|停止|停止任务|终止任务)$/iu.test(input)) return { kind: 'stop' }
  if (/^(?:status|状态|任务状态|执行状态)$/iu.test(input)) return { kind: 'status' }
  try { return { kind: 'runtime-instruction', request: parseRuntimeInstruction(input) } } catch {}
  if (/^(?:setup|安装运行时|初始化)$/iu.test(input)) return { kind: 'setup' }

  if (/^(?:startup|启动|启动游戏|打开游戏|打开明日方舟)$/iu.test(input)) {
    return { kind: 'plan', purpose: '开始唤醒', steps: [{ type: 'StartUp', clientType: 'Official' }] }
  }
  if (/^(?:closedown|关闭|关闭游戏|关闭明日方舟)$/iu.test(input)) {
    return { kind: 'plan', purpose: '关闭明日方舟', steps: [{ type: 'CloseDown' }] }
  }
  if (/^(?:infrast|基建|基建换班)$/iu.test(input)) {
    return { kind: 'plan', purpose: '基建换班', steps: [{ type: 'Infrast', mode: 0, drones: '_NotUse' }] }
  }
  if (/^(?:recruit|公招|自动公招)$/iu.test(input)) {
    return { kind: 'plan', purpose: '自动公招', steps: [{ type: 'Recruit', refresh: false, select: [4, 5, 6], confirm: [], times: 0, setTime: true, expedite: false }] }
  }
  if (/^(?:mall|credit|信用|信用收支)$/iu.test(input)) {
    return { kind: 'plan', purpose: '信用收支', steps: [{ type: 'Mall', visitFriends: true, shopping: true, buyFirst: ['招聘许可'], blacklist: ['碳', '家具', '加急许可'] }] }
  }
  if (/^(?:award|领取奖励|领奖)$/iu.test(input)) {
    return { kind: 'plan', purpose: '领取奖励', steps: [{ type: 'Award', dailyWeekly: true }] }
  }
  if (/^(?:box|operbox|扫描干员(?:box|列表)?|识别干员(?:box|列表)?)$/iu.test(input)) {
    return {
      kind: 'plan', purpose: '更新干员 Box', steps: [{ type: 'OperBox' }],
    }
  }
  if (/^(?:update|data|更新|更新数据)$/iu.test(input)) {
    return { kind: 'plan', purpose: '更新干员 Box 和仓库数据', steps: [{ type: 'OperBox' }, { type: 'Depot' }] }
  }
  if (/^(?:reclamation|reclamationalgorithm|生息|生息演算)$/iu.test(input)) {
    return { kind: 'plan', purpose: '生息演算', steps: [{ type: 'ReclamationAlgorithm', mode: 0 }] }
  }

  // Zero-model roguelike: `/maa rogue <theme> [次数] [key=value ...]`. It only
  // PREPARES the same Roguelike task the model's plan tool would produce; the
  // client turns the returned notice into the composer confirmation panel and
  // the button runs `/maa confirm`, so nothing is executed without a click.
  const rogue = input.match(/^(?:rouge|rogue|roguelike|肉鸽|自动肉鸽)(?:\s+(\S+))?(?:\s+(\d+))?(?:\s+(.+))?$/iu)
  if (rogue) {
    let theme
    if (rogue[1]) {
      try { theme = resolveRoguelikeTheme(rogue[1]) }
      catch (error) {
        // New upstream theme ids are ASCII resource directory names. Preserve
        // them here and let the active capability descriptor validate them.
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(rogue[1])) throw error
        theme = rogue[1]
      }
    }
    const count = rogue[2] === undefined ? 1 : Number(rogue[2])
    if (!Number.isInteger(count) || count < 1 || count > 99999) throw new Error('肉鸽次数必须是 1–99999。')
    return {
      kind: 'plan', purpose: `肉鸽 ${theme ?? '当前默认主题'} ×${count}`,
      steps: [{ type: 'Roguelike', theme, startsCount: count }],
      roguelikeOverrides: parseOverrides(rogue[3]),
    }
  }

  const fight = input.match(/^(?:fight|flight|刷|作战)(?:\s+([A-Za-z0-9._-]+))?(?:\s*(\d+|[一二两三四五六七八九十])\s*(?:次)?)?$/iu)
  if (fight) {
    const times = countOf(fight[2] ?? '1')
    if (!Number.isInteger(times) || times < 1 || times > 100) throw new Error('作战次数必须是 1–100。')
    return {
      kind: 'plan', purpose: `理智作战 ${fight[1] || '当前/上次关卡'} ×${times}`,
      steps: [{ type: 'Fight', stage: fight[1], times, medicine: 0, expiringMedicine: 0, stone: 0 }],
    }
  }

  throw new Error(`无法识别该本地命令。\n\n${HELP}`)
}

export { HELP as LOCAL_COMMAND_HELP }
