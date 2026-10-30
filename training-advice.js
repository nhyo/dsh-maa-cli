import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stateDirectory } from './state.js'

const VOTE_API = 'https://api.vote.ltsc.vip'
const VOTE_SITE = 'https://vote.ltsc.vip'
const CUP_LEVELS = ['超大杯上', '超大杯中', '超大杯下', '大杯', '大杯', '大杯', '中杯', '中杯', '中杯']
const TIER_ORDER = new Map(['超大杯上', '超大杯中', '超大杯下', '大杯', '中杯', '其他'].map((tier, index) => [tier, index]))
const PROFESSION_NAMES = Object.freeze({
  PIONEER: '先锋', WARRIOR: '近卫', TANK: '重装', SNIPER: '狙击',
  CASTER: '术师', MEDIC: '医疗', SUPPORT: '辅助', SPECIAL: '特种',
})

const RANKING_CACHE_VERSION = 1

export function trainingRankingFilePath(env = process.env) {
  return path.join(stateDirectory(env), 'training-ranking.json')
}

export async function loadOperatorMetadata(resourceDirectory) {
  const file = path.join(resourceDirectory, 'battle_data.json')
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  if (!parsed?.chars || typeof parsed.chars !== 'object') throw new Error(`MAA 职业数据格式无效：${file}`)
  const byId = new Map()
  const byName = new Map()
  for (const [id, raw] of Object.entries(parsed.chars)) {
    if (!raw || typeof raw.name !== 'string' || typeof raw.profession !== 'string') continue
    const item = {
      id,
      name: raw.name,
      profession: raw.profession,
      professionName: PROFESSION_NAMES[raw.profession] ?? raw.profession,
      subProfessionId: String(raw.subProfessionId ?? ''),
    }
    byId.set(id, item)
    byName.set(item.name, item)
  }
  return { byId, byName, sourceFile: file }
}

export async function fetchCommunityRanking(options = {}) {
  const now = options.now ?? Date.now()
  const env = options.env ?? process.env
  const cached = await readCommunityRankingCache({ env })
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return cachedFallback(cached, '当前 Node.js 没有 fetch()，无法检查社区强度榜更新。', now)
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  let topic
  try {
    const topics = await fetchJson(fetchImpl, `${VOTE_API}/topic/list_all`, {}, signal)
    const candidates = Array.isArray(topics?.data?.topics) ? topics.data.topics : []
    topic = candidates
      .filter(item => item?.topic_type === 'Pairwise' && Number.isFinite(Date.parse(item.close_time)) && Date.parse(item.close_time) <= now)
      .sort((a, b) => Date.parse(b.close_time) - Date.parse(a.close_time))[0]
    if (!topic) throw new Error('社区强度榜没有可用的已发布主题。')
  } catch (error) {
    if (error?.name === 'AbortError' && options.signal?.aborted) throw error
    return cachedFallback(cached, error instanceof Error ? error.message : String(error), now)
  }

  if (cached?.source?.topicId === String(topic.id) && options.fresh !== true) {
    return { ...cached, update: { checkedAt: new Date(now).toISOString(), updated: false, fallback: false, warning: '' } }
  }

  let response
  try {
    response = await fetchJson(fetchImpl, `${VOTE_API}/results/final_order`, { topic_id: topic.id }, signal)
  } catch (error) {
    if (error?.name === 'AbortError' && options.signal?.aborted) throw error
    return cachedFallback(cached, error instanceof Error ? error.message : String(error), now)
  }
  let value
  try {
    const rawItems = Array.isArray(response?.data?.items) ? response.data.items : []
    const rated = rawItems.filter(item => Number(item?.win) + Number(item?.lose) > 0)
    if (rated.length === 0) throw new Error('社区强度榜当前没有有效投票结果。')
    const items = rated.map((item, index) => ({
      name: requiredText(item.name, 'ranking.name'),
      overallRank: index + 1,
      tier: CUP_LEVELS[Math.min(8, Math.floor(index / (rated.length / 9)))] ?? '其他',
      rate: requiredText(item.rate, 'ranking.rate'),
    }))
    value = validateRankingCache({
      version: RANKING_CACHE_VERSION,
      items,
      source: {
        name: '明日方舟六星干员强度投票箱',
        url: VOTE_SITE,
        topicId: String(topic.id),
        topicTitle: String(topic.title ?? topic.name ?? topic.id),
        topicClosedAt: new Date(topic.close_time).toISOString(),
        voteCount: Number(response?.data?.count ?? 0),
        retrievedAt: new Date(now).toISOString(),
      },
    })
  } catch (error) {
    return cachedFallback(cached, error instanceof Error ? error.message : String(error), now)
  }
  let warning = ''
  try {
    await writeCommunityRankingCache(value, { env })
  } catch (error) {
    warning = `培养策略已获取，但缓存写入失败：${error instanceof Error ? error.message : String(error)}`
  }
  return { ...value, update: { checkedAt: new Date(now).toISOString(), updated: true, fallback: false, warning } }
}

export async function readCommunityRankingCache(options = {}) {
  const env = options.env ?? process.env
  try {
    return validateRankingCache(JSON.parse(await readFile(trainingRankingFilePath(env), 'utf8')))
  } catch {
    return null
  }
}

export async function writeCommunityRankingCache(ranking, options = {}) {
  const env = options.env ?? process.env
  const file = trainingRankingFilePath(env)
  const value = validateRankingCache(ranking)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return file
}

export function buildTrainingAdvice(snapshot, metadata, ranking, options = {}) {
  if (!snapshot || !Array.isArray(snapshot.operators)) throw new Error('干员 Box 缓存格式无效。')
  if (!(metadata?.byId instanceof Map) || !(metadata?.byName instanceof Map)) throw new Error('MAA 职业数据不可用。')
  if (!Array.isArray(ranking?.items)) throw new Error('社区强度榜格式无效。')
  const maxResults = integer(options.maxResults ?? 10, 1, 30, 'maxResults')
  const enriched = snapshot.operators.map(operator => ({
    ...operator,
    meta: metadata.byId.get(operator.id) ?? metadata.byName.get(operator.name) ?? null,
  }))
  const coverage = [...Object.entries(PROFESSION_NAMES)].map(([profession, professionName]) => {
    const owned = enriched.filter(operator => operator.meta?.profession === profession)
    const usable = owned.filter(operator => operator.elite >= 1)
    return { profession, professionName, ownedCount: owned.length, usableCount: usable.length, shortage: usable.length === 0 }
  })
  const shortage = new Set(coverage.filter(item => item.shortage).map(item => item.profession))

  const rankedWithClass = ranking.items.map(item => ({ ...item, meta: metadata.byName.get(item.name) ?? null }))
  const professionRanks = new Map()
  for (const item of rankedWithClass) {
    if (!item.meta) continue
    const profession = item.meta.profession
    const next = (professionRanks.get(profession) ?? 0) + 1
    professionRanks.set(profession, next)
    professionRanks.set(`${profession}:${item.name}`, next)
  }
  const ratingByName = new Map(ranking.items.map(item => [item.name, item]))
  const recommendations = enriched
    .filter(operator => operator.rarity === 6 && (operator.elite < 2 || operator.level < 60))
    .map(operator => {
      const rating = ratingByName.get(operator.name)
      const profession = operator.meta?.profession ?? 'UNKNOWN'
      const coverageBoost = shortage.has(profession)
      const professionRank = rating ? (professionRanks.get(`${profession}:${operator.name}`) ?? null) : null
      const tier = rating?.tier ?? '其他'
      const reasons = [`社区杯级：${tier}${rating ? `（总榜第 ${rating.overallRank}）` : '（当前榜单未收录）'}`]
      if (professionRank !== null) reasons.push(`${operator.meta.professionName}职业内第 ${professionRank}`)
      if (coverageBoost) reasons.push(`Box 暂无精一或精二的${operator.meta?.professionName ?? '该职业'}干员，因此提高优先级`)
      reasons.push(operator.elite < 2 ? `当前精${operator.elite} ${operator.level}级，尚未精二` : `当前精二 ${operator.level}级，可继续培养至 60 级`)
      return {
        id: operator.id,
        name: operator.name,
        profession,
        professionName: operator.meta?.professionName ?? '职业未知',
        tier,
        overallRank: rating?.overallRank ?? null,
        professionRank,
        coverageBoost,
        elite: operator.elite,
        level: operator.level,
        reasons,
      }
    })
    .sort((a, b) => {
      const tier = (TIER_ORDER.get(a.tier) ?? 99) - (TIER_ORDER.get(b.tier) ?? 99)
      if (tier !== 0) return tier
      if (a.coverageBoost !== b.coverageBoost) return a.coverageBoost ? -1 : 1
      return (a.professionRank ?? 999) - (b.professionRank ?? 999)
        || (a.overallRank ?? 999) - (b.overallRank ?? 999)
        || a.name.localeCompare(b.name, 'zh-CN')
    })
    .slice(0, maxResults)

  const strategyUpdate = ranking.update?.warning
    ? ranking.update.warning
    : ranking.update?.updated ? `培养策略已更新到“${ranking.source.topicTitle}”。` : '培养策略已是最新版本。'
  const result = {
    status: 'ready',
    scannedAt: snapshot.scannedAt,
    policy: '职业覆盖中的“可用”定义为至少精英化一；只推荐尚未精二或精二低于 60 级的已拥有六星干员。',
    recommendations,
    coverage,
    source: ranking.source,
    strategyUpdate,
  }
  return { ...result, summary: formatTrainingAdvice(result) }
}

export function formatTrainingAdvice(result) {
  if (result.status !== 'ready') return result.summary
  const lines = [
    `培养建议（基于 ${result.scannedAt} 的 Box 缓存）：`,
  ]
  if (result.recommendations.length === 0) lines.push('当前没有符合条件的六星培养候选人。')
  else result.recommendations.forEach((operator, index) => {
    lines.push(`${index + 1}. ${operator.name}｜${operator.professionName}｜${operator.tier}${operator.coverageBoost ? '｜职业缺口加权' : ''}`)
    lines.push(`   ${operator.reasons.join('；')}。`)
  })
  const gaps = result.coverage.filter(item => item.shortage).map(item => item.professionName)
  lines.push('', `职业覆盖缺口（无精一/精二）：${gaps.join('、') || '无'}。`)
  lines.push(`评级来源：${result.source.name}「${result.source.topicTitle}」（社区投票，仅作参考；${result.source.url}）。`)
  if (result.strategyUpdate) lines.push(result.strategyUpdate)
  return lines.join('\n')
}

function cachedFallback(cached, detail, now) {
  if (cached === null) throw new Error(detail)
  return {
    ...cached,
    update: {
      checkedAt: new Date(now).toISOString(), updated: false, fallback: true,
      warning: `培养策略更新检查失败，已继续使用缓存“${cached.source.topicTitle}”：${detail}`,
    },
  }
}

function validateRankingCache(value) {
  if (!value || value.version !== RANKING_CACHE_VERSION || !Array.isArray(value.items)) throw new Error('培养策略缓存格式无效。')
  const source = value.source
  if (!source || typeof source !== 'object') throw new Error('培养策略缓存来源无效。')
  const items = value.items.map(item => ({
    name: requiredText(item.name, 'ranking.name'),
    overallRank: integer(item.overallRank, 1, 10_000, 'ranking.overallRank'),
    tier: requiredText(item.tier, 'ranking.tier'),
    rate: requiredText(item.rate, 'ranking.rate'),
  }))
  return {
    version: RANKING_CACHE_VERSION,
    items,
    source: {
      name: requiredText(source.name, 'ranking.source.name'),
      url: requiredText(source.url, 'ranking.source.url'),
      topicId: requiredText(source.topicId, 'ranking.source.topicId'),
      topicTitle: requiredText(source.topicTitle, 'ranking.source.topicTitle'),
      topicClosedAt: new Date(source.topicClosedAt).toISOString(),
      voteCount: integer(source.voteCount, 0, Number.MAX_SAFE_INTEGER, 'ranking.source.voteCount'),
      retrievedAt: new Date(source.retrievedAt).toISOString(),
    },
  }
}

async function fetchJson(fetchImpl, url, body, signal) {
  const response = await fetchImpl(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'dsh-maa-cli' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`社区强度榜请求失败：HTTP ${response.status}`)
  return await response.json()
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 无效。`)
  return value.trim()
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min}–${max} 的整数。`)
  return value
}
