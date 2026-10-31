import { fetchJson } from '../agent/http.js'

// Read-only client for the MAA copilot site (prts.plus / zoot.plus). The
// backend is MaaBackendCenter: GET /copilot/query (level_keyword, page, limit,
// order_by, desc) and GET /copilot/get/{id}. Each item carries the job JSON in
// `content` as a string.
export const COPILOT_SITE = 'https://prts.maa.plus'
const MAX_JOB_BYTES = 2 * 1024 * 1024

export async function searchCopilots(query, options = {}) {
  const keyword = String(query?.stage ?? query?.keyword ?? '').trim()
  if (!keyword || keyword.length > 48) throw new TypeError('请提供 1–48 个字符的关卡名或关键字。')
  const limit = Math.min(Math.max(Number(query?.limit) || 10, 1), 30)
  const orderBy = ['hot', 'views', 'id'].includes(query?.orderBy) ? query.orderBy : 'hot'
  const params = new URLSearchParams({ level_keyword: keyword, page: '1', limit: String(limit), order_by: orderBy, desc: 'true' })
  if (query?.operator) params.set('operator', String(query.operator).slice(0, 32))
  const { data } = await fetchJson(`${options.baseUrl ?? COPILOT_SITE}/copilot/query?${params}`, { ...options, timeoutMs: options.timeoutMs ?? 20_000, maxBytes: 8 * 1024 * 1024 })
  const page = unwrap(data)
  const list = Array.isArray(page?.data) ? page.data : Array.isArray(page) ? page : null
  if (!list) throw new Error('作业站返回格式无法识别。')
  return list.map(item => summarizeItem(item)).filter(Boolean)
}

export async function getCopilot(id, options = {}) {
  const value = String(id ?? '').replace(/^maa:\/\//u, '').trim()
  if (!/^\d{1,12}$/u.test(value)) throw new TypeError('作业 ID 必须是数字（可写成 maa://12345）。')
  const { data } = await fetchJson(`${options.baseUrl ?? COPILOT_SITE}/copilot/get/${value}`, { ...options, timeoutMs: options.timeoutMs ?? 20_000, maxBytes: MAX_JOB_BYTES })
  const item = summarizeItem(unwrap(data))
  if (!item) throw new Error(`作业站没有返回作业 ${value} 的内容。`)
  return item
}

// Compare a job's operator list against the verified OperBox cache.
export function evaluateCopilotOwnership(job, box) {
  if (!box || !Array.isArray(box.operators)) return { status: 'unknown', missing: [], weak: [], reason: '没有干员 Box 缓存，无法判断是否缺干员；可先扫描 Box。' }
  const owned = new Map(box.operators.map(operator => [operator.name, operator]))
  const missing = []
  const weak = []
  for (const oper of job.opers) {
    const mine = owned.get(oper.name)
    if (!mine) { missing.push(oper.name); continue }
    const reason = shortfall(oper, mine)
    if (reason) weak.push(`${oper.name}（${reason}）`)
  }
  for (const group of job.groups) {
    const usable = group.opers.some(oper => owned.has(oper.name) && !shortfall(oper, owned.get(oper.name)))
    if (usable) continue
    const ownedAny = group.opers.some(oper => owned.has(oper.name))
    ;(ownedAny ? weak : missing).push(`${group.name}组（${group.opers.map(oper => oper.name).join('/')}任一${ownedAny ? '，已有的练度不够' : ''}）`)
  }
  return { status: missing.length === 0 && weak.length === 0 ? 'ok' : 'missing', missing, weak, reason: '' }
}

export function rankCopilots(items, box) {
  return items.map(item => ({ ...item, ownership: evaluateCopilotOwnership(item.job, box) }))
    .sort((a, b) => ownershipRank(a.ownership) - ownershipRank(b.ownership) || b.hotScore - a.hotScore)
}

export function formatCopilotCandidate(item, index) {
  const ownership = item.ownership
  const status = ownership?.status === 'ok' ? '干员齐全'
    : ownership?.status === 'missing' ? `缺 ${[...ownership.missing, ...ownership.weak].join('、')}`
      : '未判断干员'
  return `${index + 1}. maa://${item.id}｜${item.job.title || item.job.stageName}｜作者 ${item.uploader || '未知'}｜${item.views} 次浏览｜${item.job.opers.length + item.job.groups.length} 名干员｜${status}`
}

// Skill 2 unlocks at elite 1 and skill 3 at elite 2; explicit job
// requirements (elite/level) are checked as well.
function shortfall(oper, mine) {
  const skillElite = oper.skill >= 3 ? 2 : oper.skill === 2 ? 1 : 0
  const need = oper.requirements ?? {}
  const elite = Math.max(skillElite, Number.isInteger(need.elite) ? need.elite : 0)
  if (mine.elite < elite) return `需要精${elite}${oper.skill >= 2 ? `（${oper.skill} 技能）` : ''}，当前精${mine.elite}`
  if (Number.isInteger(need.elite) && mine.elite === need.elite && Number.isInteger(need.level) && mine.level < need.level) return `需要精${need.elite} ${need.level}级，当前 ${mine.level}级`
  return ''
}

function ownershipRank(ownership) { return ownership?.status === 'ok' ? 0 : ownership?.status === 'unknown' ? 1 : 2 + (ownership?.missing?.length ?? 0) }

function unwrap(body) {
  if (body && typeof body === 'object' && 'data' in body && ('status_code' in body || 'statusCode' in body || 'message' in body)) return body.data
  return body
}

function summarizeItem(item) {
  if (!item || typeof item !== 'object' || typeof item.content !== 'string') return null
  if (Buffer.byteLength(item.content) > MAX_JOB_BYTES) return null
  let content
  try { content = JSON.parse(item.content) } catch { return null }
  const job = parseJob(content)
  if (!job) return null
  return {
    id: String(item.id ?? ''),
    uploader: String(item.uploader ?? ''),
    views: Number(item.views) || 0,
    hotScore: Number(item.hot_score ?? item.hotScore) || 0,
    like: Number(item.like) || 0,
    dislike: Number(item.dislike) || 0,
    job, content,
  }
}

function parseJob(content) {
  if (!content || typeof content !== 'object' || typeof content.stage_name !== 'string') return null
  const opers = (Array.isArray(content.opers) ? content.opers : []).filter(oper => typeof oper?.name === 'string')
    .map(oper => ({ name: oper.name, skill: Number(oper.skill) || 1, requirements: oper.requirements && typeof oper.requirements === 'object' ? oper.requirements : {} }))
  const groups = (Array.isArray(content.groups) ? content.groups : []).filter(group => typeof group?.name === 'string' && Array.isArray(group.opers))
    .map(group => ({ name: group.name, opers: group.opers.filter(oper => typeof oper?.name === 'string').map(oper => ({ name: oper.name, skill: Number(oper.skill) || 1 })) }))
  return {
    stageName: content.stage_name,
    title: String(content.doc?.title ?? '').slice(0, 80),
    details: String(content.doc?.details ?? '').slice(0, 300),
    // SSS (保全派驻) jobs declare type "SSS"; everything else is a normal job.
    kind: String(content.type ?? '').toUpperCase() === 'SSS' ? 'SSSCopilot' : 'Copilot',
    opers, groups,
  }
}
