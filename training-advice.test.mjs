import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildTrainingAdvice, fetchCommunityRanking, loadOperatorMetadata, readCommunityRankingCache } from './training-advice.js'

function snapshot(operators) {
  return { version: 1, scannedAt: '2026-10-29T12:00:00.000Z', operators }
}

test('loads profession data from the existing MAA battle_data resource', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-advice-'))
  try {
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'battle_data.json'), JSON.stringify({ chars: {
      char_a: { name: '甲', profession: 'SNIPER', subProfessionId: 'marksman' },
    } }))
    const metadata = await loadOperatorMetadata(root)
    assert.equal(metadata.byId.get('char_a').professionName, '狙击')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps cup priority, uses profession rank, and explains coverage boosts', () => {
  const chars = [
    ['char_a', '甲', 'SNIPER'], ['char_b', '乙', 'SNIPER'], ['char_c', '丙', 'MEDIC'],
    ['char_low', '低星医疗', 'MEDIC'],
  ]
  const metadata = {
    byId: new Map(chars.map(([id, name, profession]) => [id, { id, name, profession, professionName: profession === 'SNIPER' ? '狙击' : '医疗' }])),
    byName: new Map(chars.map(([id, name, profession]) => [name, { id, name, profession, professionName: profession === 'SNIPER' ? '狙击' : '医疗' }])),
  }
  const ranking = {
    items: [
      { name: '甲', overallRank: 1, tier: '超大杯上', rate: '90%' },
      { name: '丙', overallRank: 2, tier: '超大杯上', rate: '89%' },
      { name: '乙', overallRank: 3, tier: '超大杯上', rate: '88%' },
    ],
    source: { name: '测试榜', topicTitle: '测试主题', url: 'https://example.test' },
  }
  const result = buildTrainingAdvice(snapshot([
    { id: 'char_a', name: '甲', rarity: 6, elite: 0, level: 1, potential: 1 },
    { id: 'char_b', name: '乙', rarity: 6, elite: 0, level: 1, potential: 1 },
    { id: 'char_c', name: '丙', rarity: 6, elite: 0, level: 1, potential: 1 },
    { id: 'char_low', name: '低星医疗', rarity: 4, elite: 1, level: 1, potential: 1 },
  ]), metadata, ranking)

  assert.deepEqual(result.recommendations.map(item => item.name), ['甲', '乙', '丙'])
  assert.equal(result.recommendations[0].professionRank, 1)
  assert.equal(result.recommendations[1].professionRank, 2)
  assert.equal(result.recommendations[0].coverageBoost, true)
  assert.equal(result.recommendations[2].coverageBoost, false)
  assert.match(result.recommendations[0].reasons.join(''), /Box 暂无精一或精二的狙击干员/)
  assert.match(result.summary, /职业缺口加权/)
})

test('always pins owned Skadi operators with the requested reason', () => {
  const chars = [
    ['char_skadi', '斯卡蒂', 'WARRIOR', '近卫'],
    ['char_skalt', '浊心斯卡蒂', 'SUPPORT', '辅助'],
    ['char_top', '榜首', 'SNIPER', '狙击'],
  ]
  const metadata = {
    byId: new Map(chars.map(([id, name, profession, professionName]) => [id, { id, name, profession, professionName }])),
    byName: new Map(chars.map(([id, name, profession, professionName]) => [name, { id, name, profession, professionName }])),
  }
  const ranking = {
    items: [
      { name: '榜首', overallRank: 1, tier: '超大杯上', rate: '99%' },
      { name: '浊心斯卡蒂', overallRank: 2, tier: '超大杯上', rate: '98%' },
      { name: '斯卡蒂', overallRank: 3, tier: '超大杯上', rate: '97%' },
    ],
    source: { name: '测试榜', topicTitle: '测试主题', url: 'https://example.test' },
  }
  const result = buildTrainingAdvice(snapshot([
    { id: 'char_top', name: '榜首', rarity: 6, elite: 0, level: 1, potential: 1 },
    { id: 'char_skalt', name: '浊心斯卡蒂', rarity: 6, elite: 2, level: 90, potential: 6 },
    { id: 'char_skadi', name: '斯卡蒂', rarity: 6, elite: 2, level: 90, potential: 6 },
  ]), metadata, ranking)

  assert.deepEqual(result.recommendations.slice(0, 3).map(item => item.name), ['斯卡蒂', '浊心斯卡蒂', '榜首'])
  assert.deepEqual(result.recommendations[0].reasons, ['这是蒂蒂，她很可爱！！！！'])
  assert.deepEqual(result.recommendations[1].reasons, ['这是蒂蒂，她很可爱！！！！'])
})

test('derives cup levels from the published vote order and ignores zero-vote entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-maa-ranking-'))
  const env = { DSH_MAA_CLI_STATE_DIR: root }
  try {
    const responses = [
      { data: { topics: [{ id: 'new', title: '新主题', topic_type: 'Pairwise', close_time: '2026-07-17T21:00:00Z' }] } },
      { data: { items: Array.from({ length: 10 }, (_, index) => ({ name: `干员${index}`, win: index === 9 ? 0 : 10, lose: index === 9 ? 0 : 1, rate: '90%' })), count: 99 } },
    ]
    const fetchImpl = async () => ({ ok: true, json: async () => responses.shift() })
    const result = await fetchCommunityRanking({ fetchImpl, env, now: Date.parse('2026-10-29T12:00:00Z') })
    assert.equal(result.items.length, 9)
    assert.equal(result.update.updated, true)
    assert.deepEqual(result.items.map(item => item.tier), ['超大杯上', '超大杯中', '超大杯下', '大杯', '大杯', '大杯', '中杯', '中杯', '中杯'])
    assert.equal((await readCommunityRankingCache({ env })).source.topicId, 'new')

    let calls = 0
    const sameTopic = async () => {
      calls += 1
      return { ok: true, json: async () => ({ data: { topics: [{ id: 'new', title: '新主题', topic_type: 'Pairwise', close_time: '2026-07-17T21:00:00Z' }] } }) }
    }
    const unchanged = await fetchCommunityRanking({ fetchImpl: sameTopic, env, now: Date.parse('2026-10-29T13:00:00Z') })
    assert.equal(calls, 1)
    assert.equal(unchanged.update.updated, false)

    const fallback = await fetchCommunityRanking({ fetchImpl: async () => { throw new Error('offline') }, env, now: Date.parse('2026-10-29T14:00:00Z') })
    assert.equal(fallback.update.fallback, true)
    assert.match(fallback.update.warning, /继续使用缓存/)
    assert.equal(fallback.source.topicId, 'new')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
