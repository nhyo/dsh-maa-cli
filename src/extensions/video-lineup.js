// Compare a video lineup (from the dsh-maa-coverocr companion) with the
// user's operator Box. Only ownership matters here — no level or skill
// check — and one missing operator still counts, because it can be borrowed
// as the support unit.

const SOURCE_LABEL = { cover: '封面', title: '标题', description: '简介', tags: '标签', comments: 'UP 主评论' }
const CERTAINTY_LABEL = { certain: '确定', likely: '较可能', guess: '推测' }

export function evaluateVideoLineup(analysis, box) {
  const operators = Array.isArray(analysis?.operators) ? analysis.operators : []
  const owned = new Set((box?.operators ?? []).map(operator => operator.name))
  const missing = operators.filter(operator => !owned.has(operator.name)).map(operator => operator.name)
  // A squad-screen cover read with confidence shows the whole team; anything
  // else (text, a title card) may only name part of it.
  const complete = analysis?.cover?.layout === 'squad' && operators.some(operator => operator.sources?.includes('cover') && operator.certainty === 'certain')
  let verdict
  if (operators.length === 0) verdict = 'unknown'
  else if (missing.length === 0) verdict = 'ok'
  else if (missing.length === 1) verdict = 'support'
  else verdict = 'missing'
  return { verdict, matches: verdict === 'ok' || verdict === 'support', complete, missing, operators }
}

const VERDICT_LABEL = {
  ok: '可抄',
  support: '可抄（需借助战）',
  missing: '不可抄',
  unknown: '未识别出干员',
}

export function formatVideoLineup(analysis, evaluation, index) {
  const lines = []
  const video = analysis.video
  lines.push(`${index + 1}. 【${VERDICT_LABEL[evaluation.verdict]}】${video.title || video.bvid}｜UP：${video.owner || '未知'}`)
  lines.push(`   链接：${video.url}`)
  if (evaluation.operators.length > 0) {
    lines.push(`   阵容${evaluation.complete ? '（封面编队，较完整）' : '（部分信息，可能不完整）'}：${evaluation.operators.map(operator => `${operator.name}[${CERTAINTY_LABEL[operator.certainty] ?? operator.certainty}·${operator.sources.map(source => SOURCE_LABEL[source] ?? source).join('/')}]`).join('、')}`)
  }
  if (evaluation.verdict === 'support') lines.push(`   缺 1 名：${evaluation.missing[0]}（可借助战）`)
  if (evaluation.verdict === 'missing') lines.push(`   缺 ${evaluation.missing.length} 名：${evaluation.missing.join('、')}`)
  if (analysis.maaCodes?.length) lines.push(`   简介/评论里有作业码：${analysis.maaCodes.map(code => `maa://${code}`).join('、')}（可交给作业站流程直接执行）`)
  const coverNote = { unavailable: '封面未识别', failed: '封面识别失败', 'no-operators': '封面上没有识别出干员名' }[analysis.cover?.status]
  if (coverNote) lines.push(`   ${coverNote}${analysis.cover?.detail ? `：${analysis.cover.detail}` : ''}`)
  return lines.join('\n')
}
