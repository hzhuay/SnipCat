/**
 * 视频元数据探测。
 */

import { statSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { buildProbeCommand } from '@shared/commands'
import { parseProbeOutput } from '@shared/probe'
import { formatCompact } from '@shared/time'
import type { VideoMeta } from '@shared/types'
import { logInfo, logError } from '../log'
import { requireBinaries } from './locate'
import { runChecked } from './runner'

/**
 * 对一个文件跑 ffprobe 并归一化成 VideoMeta。
 *
 * 路径拆分在这里做（用 node:path），因为 shared 层刻意不依赖 node:path ——
 * 那样渲染进程才能安全 import shared 的纯函数。
 */
export async function probeVideo(filePath: string): Promise<VideoMeta> {
  const { ffprobe } = await requireBinaries()

  logInfo(`探测元数据：${filePath}`)

  let sizeBytes = 0
  try {
    sizeBytes = statSync(filePath).size
  } catch {
    logError(`无法访问文件：${filePath}`)
    throw new Error(`无法访问文件：${filePath}`)
  }

  const cmd = buildProbeCommand(filePath)
  const r = await runChecked(ffprobe, cmd.argv)

  const ext = extname(filePath)
  const meta = parseProbeOutput(r.stdout, {
    path: filePath,
    dir: dirname(filePath),
    base: basename(filePath, ext),
    ext,
  })

  const v = meta.streams.find((s) => s.codecType === 'video')
  const videoDesc = v
    ? `${v.width}×${v.height} ${v.codecName}${v.rFrameRate ? ` @ ${v.rFrameRate}` : ''}`
    : '无视频流'
  logInfo(
    `元数据：时长 ${formatCompact(meta.durationSec)}，${videoDesc}，` +
      `共 ${meta.streams.length} 条流`
  )

  // ffprobe 的 format.size 有时缺失，用 fs 的结果更可靠
  return { ...meta, sizeBytes: sizeBytes || meta.sizeBytes }
}
