const HELP = [
  '常用 MAA 本地命令（不会调用模型）：',
  '/maa fight 1-7 2  或  /maa 刷 1-7 2次',
  '/maa startup      或  /maa 启动游戏',
  '/maa infrast      或  /maa 基建换班',
  '/maa award        或  /maa 领取奖励',
  '/maa box          或  /maa 扫描干员Box',
  '/maa closedown    或  /maa 关闭游戏',
  '/maa stop         或  /maa 停止任务',
  '/maa confirm MAA-XXXXXX  确认并执行待确认计划（可附加肉鸽参数，如 theme=Sarkaz mode=0 difficulty=4 squad=蓝图测绘分队）',
  '                  末尾也可加 note=<URL 编码的备注>，备注只交给 DSH 自行参考，不保证执行',
  '/maa setup        安装本机 MAA 运行时（首次使用）',
  '',
  '作战默认不使用理智药、临期理智药或源石；基建默认不使用无人机。',
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
    if (index <= 0 || index === token.length - 1) {
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

  const confirm = input.match(/^confirm\s+(MAA-[A-F0-9]{6})(?:\s+(.+))?$/iu)
  if (confirm) return { kind: 'confirm', confirmationCode: confirm[1].toUpperCase(), overrides: parseOverrides(confirm[2]) }
  if (/^(?:stop|停止|停止任务|终止任务)$/iu.test(input)) return { kind: 'stop' }
  if (/^(?:setup|安装运行时|初始化)$/iu.test(input)) return { kind: 'setup' }

  if (/^(?:startup|启动|启动游戏|打开游戏|打开明日方舟)$/iu.test(input)) {
    return { kind: 'execute', purpose: '启动明日方舟', steps: [{ type: 'StartUp', clientType: 'Official' }] }
  }
  if (/^(?:closedown|关闭|关闭游戏|关闭明日方舟)$/iu.test(input)) {
    return { kind: 'execute', purpose: '关闭明日方舟', steps: [{ type: 'CloseDown' }] }
  }
  if (/^(?:infrast|基建|基建换班)$/iu.test(input)) {
    return { kind: 'execute', purpose: '基建换班（不使用无人机）', steps: [{ type: 'Infrast', drones: '_NotUse' }] }
  }
  if (/^(?:award|领取奖励|领奖)$/iu.test(input)) {
    return { kind: 'execute', purpose: '领取日常和周常奖励', steps: [{ type: 'Award', dailyWeekly: true }] }
  }
  if (/^(?:box|operbox|扫描干员(?:box|列表)?|识别干员(?:box|列表)?)$/iu.test(input)) {
    return {
      kind: 'execute', purpose: '扫描干员 Box',
      steps: [{ type: 'StartUp', clientType: 'Official' }, { type: 'OperBox' }],
    }
  }

  const fight = input.match(/^(?:fight|刷|作战)\s*([A-Za-z0-9._-]+)(?:\s*(\d+|[一二两三四五六七八九十])\s*(?:次)?)?$/iu)
  if (fight) {
    const times = countOf(fight[2] ?? '1')
    if (!Number.isInteger(times) || times < 1 || times > 100) throw new Error('作战次数必须是 1–100。')
    return {
      kind: 'execute', purpose: `刷 ${fight[1]} ×${times}`,
      steps: [{ type: 'Fight', stage: fight[1], times, medicine: 0, expiringMedicine: 0, stone: 0 }],
    }
  }

  throw new Error(`无法识别该本地命令。\n\n${HELP}`)
}

export { HELP as LOCAL_COMMAND_HELP }
