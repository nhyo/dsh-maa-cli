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
    description: 'Check Bilibili Arknights strategy videos (作业视频) against the user\'s operator Box. Give 1–5 video links (bilibili.com/video/BV…, b23.tv short links or BV ids) the user provided; keyword search is not supported. Needs the companion plugin dsh-maa-coverocr: if the result status is needs_extension, tell the user to type `/maa ext install coverocr` themselves — never claim you analyzed the video. Only ownership is checked (no level/skill); one missing operator still counts as copyable via the support unit. Report each video\'s verdict, lineup with its sources and the video link so the user can copy it manually. This tool never operates the game.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['videos'],
      properties: {
        videos: { type: 'array', minItems: 1, maxItems: MAX_VIDEOS, items: { type: 'string' }, description: 'Bilibili video URLs, b23.tv short links or BV ids.' },
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

      const videos = [...new Set(args.videos.map(video => String(video).trim()).filter(Boolean))].slice(0, MAX_VIDEOS)
      const reports = []
      const results = []
      for (const [index, video] of videos.entries()) {
        try {
          const analysis = await service.analyzeVideo({ video, operatorNames: [...names.keys()], resourceDir, signal: exec.signal })
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
        summary: [boxNote, '', ...reports, '', '链接请交给用户自己打开观看、手动抄作业。'].join('\n'),
        data: { boxScannedAt: box?.scannedAt ?? '', results },
      })
    },
  })
}
