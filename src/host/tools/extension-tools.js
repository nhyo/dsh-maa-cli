// Tools backed by companion plugins (see src/extensions/).
import { AGENT_RESULT_SCHEMA, agentResult, renderAgentResult } from '../tool-schemas.js'
import { extensionService } from '../../extensions/host.js'
import { evaluateVideoLineup, formatVideoLineup } from '../../extensions/video-lineup.js'
import { readOperatorBox } from '../../operators/operator-box.js'
import { loadOperatorNames } from '../../strategy/compiler.js'
import { requireMaaCli } from '../../runtime/maa-cli.js'
import { queryArguments, runMaa } from '../../runtime/runner.js'

const MAX_VIDEOS = 5

export function registerExtensionTools(ctx) {
  ctx.tools.register({
    name: 'maa_video_lineup',
    description: 'Search Bilibili for Arknights strategy videos by stage/query, using exactly 明日方舟 + the user query, or inspect 1–5 supplied video links. The dsh-maa-coverocr companion only reads metadata and cover images; it never downloads or watches video streams. Compare cover OCR results with the user\'s operator Box. Needs dsh-maa-coverocr; if missing, report needs_extension. Only ownership is checked (no level/skill); one missing operator still counts as copyable via support. MANDATORY: every user-facing answer that recommends or lists a Bilibili strategy must include the corresponding clickable video URL for every item; never give a strategy recommendation without its video link. This tool never operates the game.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        videos: { type: 'array', minItems: 1, maxItems: MAX_VIDEOS, items: { type: 'string' }, description: 'Bilibili video URLs, b23.tv short links or BV ids.' },
        query: { type: 'string', minLength: 1, description: 'Stage code or search terms, e.g. TL-EX-8. The companion only adds 明日方舟 when absent.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_VIDEOS, default: 5 },
      },
    },
    output: { schema: AGENT_RESULT_SCHEMA, render: renderAgentResult },
    async execute(args, exec) {
      const { entry, status, service } = extensionService(ctx, 'coverocr')
      if (service === null) {
        return agentResult({
          status: 'needs_extension',
          summary: `此功能需要辅助插件 ${entry.packageName}（${entry.title}），当前状态：${status.detail} 请让用户在对话中输入 /maa ext install ${entry.id}，会直接下载安装（${entry.size}）；不要自行分析视频或编造阵容。`,
          data: { extension: entry.id, state: status.state },
        })
      }
      const box = await readOperatorBox()
      let resourceDir
      try {
        await requireMaaCli()
        const directory = await runMaa(queryArguments('resource_dir'), { signal: exec.signal, timeoutMs: 30_000 })
        resourceDir = directory.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1)
        if (directory.exitCode !== 0 || !resourceDir) throw new Error(directory.stderr || directory.stdout || `exit ${directory.exitCode}`)
      } catch (error) {
        return agentResult({ status: 'source_error', summary: `无法读取 MAA 资源目录（干员名单和识别模型都在这里）：${error instanceof Error ? error.message : String(error)}` })
      }
      const names = await loadOperatorNames(resourceDir)
      if (names === null) return agentResult({ status: 'source_error', summary: 'MAA 资源里的干员名单（battle_data.json）无法读取。' })

      let videos = Array.isArray(args.videos) ? [...new Set(args.videos.map(video => String(video).trim()).filter(Boolean))].slice(0, MAX_VIDEOS) : []
      let searched = null
      if (videos.length === 0 && String(args.query ?? '').trim() !== '') {
        try {
          searched = await service.searchVideos({ query: String(args.query).trim(), limit: args.limit ?? MAX_VIDEOS, operatorNames: [...names.keys()], resourceDir, signal: exec.signal })
          videos = searched.videos
        } catch (error) {
          if (exec.signal?.aborted) throw error
          return agentResult({ status: 'source_error', summary: `B 站搜索失败：${error instanceof Error ? error.message : String(error)}` })
        }
      }
      if (videos.length === 0) return agentResult({ status: 'invalid_input', summary: '请提供搜索关键词（例如 TL-EX-8）或 1–5 个 B 站视频链接。' })
      const reports = []
      const results = []
      for (const [index, video] of videos.entries()) {
        try {
          const analysis = typeof video === 'string'
            ? await service.analyzeVideo({ video, operatorNames: [...names.keys()], resourceDir, signal: exec.signal })
            : video
          const evaluation = evaluateVideoLineup(analysis, box)
          reports.push(formatVideoLineup(analysis, evaluation, index))
          results.push({ video: analysis.video, verdict: evaluation.verdict, complete: evaluation.complete, missing: evaluation.missing, operators: evaluation.operators, maaCodes: analysis.maaCodes, cover: analysis.cover.status, warnings: analysis.warnings })
        } catch (error) {
          if (exec.signal?.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          reports.push(`${index + 1}. 【读取失败】${video}\n   ${message}`)
          results.push({ video: { input: video }, verdict: 'error', error: message })
        }
      }
      const boxNote = box === null
        ? '注意：还没有干员 Box 缓存，无法判断你是否拥有这些干员，下面全部按“未拥有”计算；可先扫描一次 Box。'
        : `干员 Box：${box.scannedAt} 扫描，共 ${box.operators.length} 名。只判断是否拥有，不看练度与技能；缺 1 名也算可抄（借助战）。`
      return agentResult({
        status: 'ok',
        summary: [searched ? `B 站搜索：明日方舟 ${searched.query}（只读取封面，不下载视频）` : '', boxNote, '', ...reports, '', '回答用户时必须逐条保留上面的对应视频链接，让用户自己打开观看、手动抄作业；不得只给标题或结论。'].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n'),
        data: { query: searched?.query ?? '', boxScannedAt: box?.scannedAt ?? '', results },
      })
    },
  })
}
