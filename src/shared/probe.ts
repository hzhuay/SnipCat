/**
 * ffprobe JSON 输出 → VideoMeta 的归一化。
 *
 * 放在 shared 而不是 main：这是纯函数，可以用固化的 fixture 单测，
 * 而 fixture 是在没有 ffmpeg 的机器上验证命令构造逻辑的唯一手段。
 */

import type { StreamInfo, VideoMeta } from './types'

/** ffprobe 原始输出的形状（只声明用到的字段） */
interface RawProbe {
  format?: {
    filename?: string
    format_name?: string
    duration?: string
    size?: string
    bit_rate?: string
  }
  streams?: RawStream[]
}

interface RawStream {
  index?: number
  codec_type?: string
  codec_name?: string
  profile?: string
  level?: number
  width?: number
  height?: number
  pix_fmt?: string
  r_frame_rate?: string
  bit_rate?: string
  sample_rate?: string
  channels?: number
  channel_layout?: string
  color_primaries?: string
  color_transfer?: string
  color_space?: string
  tags?: Record<string, string>
}

const KNOWN_TYPES = new Set(['video', 'audio', 'subtitle', 'data', 'attachment'])

function num(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 把 ffprobe JSON 归一化为 VideoMeta。
 *
 * @param json ffprobe 的 stdout 文本
 * @param pathInfo 由调用方用 node:path 拆好的路径信息（shared 不依赖 node:path，
 *                 这样渲染进程也能安全 import 本模块）
 */
export function parseProbeOutput(
  json: string,
  pathInfo: { path: string; dir: string; base: string; ext: string }
): VideoMeta {
  let raw: RawProbe
  try {
    raw = JSON.parse(json) as RawProbe
  } catch {
    throw new Error('无法解析 ffprobe 输出，可能不是有效的媒体文件')
  }

  const streams: StreamInfo[] = (raw.streams ?? []).map((s) => ({
    index: s.index ?? 0,
    codecType: (KNOWN_TYPES.has(s.codec_type ?? '')
      ? s.codec_type
      : 'unknown') as StreamInfo['codecType'],
    codecName: s.codec_name ?? 'unknown',
    profile: s.profile,
    level: s.level,
    width: s.width,
    height: s.height,
    pixFmt: s.pix_fmt,
    rFrameRate: s.r_frame_rate,
    bitRate: num(s.bit_rate),
    sampleRate: num(s.sample_rate),
    channels: s.channels,
    channelLayout: s.channel_layout,
    colorPrimaries: s.color_primaries,
    colorTransfer: s.color_transfer,
    colorSpace: s.color_space,
    tags: s.tags,
  }))

  if (!streams.some((s) => s.codecType === 'video')) {
    throw new Error('该文件不含视频流')
  }

  const duration = num(raw.format?.duration)
  if (duration === undefined || duration <= 0) {
    throw new Error('无法读取视频时长，该文件可能已损坏')
  }

  return {
    path: pathInfo.path,
    dir: pathInfo.dir,
    base: pathInfo.base,
    ext: pathInfo.ext,
    sizeBytes: num(raw.format?.size) ?? 0,
    durationSec: duration,
    formatName: raw.format?.format_name ?? 'unknown',
    bitRate: num(raw.format?.bit_rate),
    streams,
  }
}

/** 把分数帧率字符串（"30000/1001"）算成小数，用于展示 */
export function frameRateToNumber(r: string | undefined): number | null {
  if (!r) return null
  const [a, b] = r.split('/').map(Number)
  if (!Number.isFinite(a)) return null
  if (b === undefined) return a
  if (!Number.isFinite(b) || b === 0) return null
  return a / b
}

/** 生成一行人类可读的视频摘要，用于 UI 的元数据区 */
export function describeMeta(meta: VideoMeta): string[] {
  const lines: string[] = []
  const v = meta.streams.find((s) => s.codecType === 'video')
  const a = meta.streams.find((s) => s.codecType === 'audio')

  if (v) {
    const parts = [v.codecName]
    if (v.profile) {
      parts.push(v.level ? `${v.profile}@${(v.level / 10).toFixed(1)}` : v.profile)
    }
    if (v.width && v.height) parts.push(`${v.width}×${v.height}`)
    if (v.pixFmt) parts.push(v.pixFmt)
    const fps = frameRateToNumber(v.rFrameRate)
    if (fps) parts.push(`${fps.toFixed(2).replace(/\.00$/, '')}fps`)
    lines.push(parts.join(' · '))
  }

  if (a) {
    const parts = [a.codecName]
    if (a.sampleRate) parts.push(`${(a.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')}kHz`)
    if (a.channels) {
      parts.push(a.channels === 1 ? '单声道' : a.channels === 2 ? '立体声' : `${a.channels} 声道`)
    }
    const extraAudio = meta.streams.filter((s) => s.codecType === 'audio').length - 1
    if (extraAudio > 0) parts.push(`+${extraAudio} 条音轨`)
    lines.push(parts.join(' · '))
  }

  const subs = meta.streams.filter((s) => s.codecType === 'subtitle').length
  if (subs > 0) lines.push(`${subs} 条字幕轨`)

  return lines
}

/** 格式化文件体积 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}
