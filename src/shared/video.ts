/**
 * 视频参数的派生计算。
 *
 * 放在 shared：主进程算吸附余量、渲染进程算逐帧步进，用的是同一套逻辑。
 */

import type { VideoMeta } from './types'
import { frameRateToNumber } from './probe'

/** 帧率未知时的兜底值 */
const FALLBACK_FPS = 30

/** 取第一条视频流的帧率（帧/秒），未知时回退到 30 */
export function videoFps(meta: VideoMeta): number {
  const v = meta.streams.find((s) => s.codecType === 'video')
  const fps = frameRateToNumber(v?.rFrameRate)
  return fps && fps > 0 ? fps : FALLBACK_FPS
}

/** 单帧时长（秒），用于逐帧步进和终点余量 */
export function frameDuration(meta: VideoMeta): number {
  return 1 / videoFps(meta)
}
