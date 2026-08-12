/**
 * 时间段的校验规则。
 *
 * 设计原则：只有真正会导致 ffmpeg 失败或语义矛盾的情况才是 error；
 * 用户可能故意为之的（重叠、乱序）只给 warning，不阻止执行。
 */

import type { Segment, SegmentIssue, ValidationResult, VideoMeta } from './types'
import { formatCompact } from './time'

/** 终点超出视频时长时允许的容差（秒），小于此值直接静默截断不提示 */
const DURATION_TOLERANCE = 0.05

/**
 * 校验全部时间段。
 *
 * @param segments 用户编辑中的段落列表（顺序即拼接顺序）
 * @param meta 输入视频元数据，为 null 时只做段内自洽校验
 */
export function validateSegments(
  segments: Segment[],
  meta: VideoMeta | null
): ValidationResult {
  const issues: SegmentIssue[] = []
  let totalDurationSec = 0

  if (segments.length === 0) {
    return { issues, hasError: false, totalDurationSec: 0 }
  }

  const duration = meta?.durationSec ?? null

  segments.forEach((seg, i) => {
    const err = (message: string) =>
      issues.push({ segmentId: seg.id, level: 'error', message })
    const warn = (message: string) =>
      issues.push({ segmentId: seg.id, level: 'warning', message })

    // 空输入不算错误 —— 刚点"添加时间段"时两个框都是空的，此时报错很吵
    const startEmpty = seg.startRaw.trim() === ''
    const endEmpty = seg.endRaw.trim() === ''
    if (startEmpty && endEmpty) return

    if (seg.startSec === null) {
      err(startEmpty ? '请填写起点' : '起点：无法识别的时间格式')
      return
    }
    if (seg.endSec === null) {
      err(endEmpty ? '请填写终点' : '终点：无法识别的时间格式')
      return
    }

    if (seg.endSec <= seg.startSec) {
      err('终点必须晚于起点')
      return
    }

    let effectiveEnd = seg.endSec

    if (duration !== null) {
      if (seg.startSec >= duration) {
        err(`起点超出视频时长（${formatCompact(duration)}）`)
        return
      }
      if (seg.endSec > duration + DURATION_TOLERANCE) {
        // 不算错误：截断到片尾是明确且无害的处理
        warn(`终点已截断至片尾（${formatCompact(duration)}）`)
      }
      effectiveEnd = Math.min(seg.endSec, duration)
    }

    totalDurationSec += effectiveEnd - seg.startSec

    // 重叠只警告：重复使用同一片段是合法需求
    for (let j = 0; j < i; j++) {
      const other = segments[j]
      if (other.startSec === null || other.endSec === null) continue
      if (seg.startSec < other.endSec && effectiveEnd > other.startSec) {
        warn(`与第 ${j + 1} 段重叠`)
        break
      }
    }
  })

  return {
    issues,
    hasError: issues.some((it) => it.level === 'error'),
    totalDurationSec,
  }
}

/**
 * 取出可以执行的段落：解析成功、起止合法、并把终点截断到视频时长内。
 *
 * 空白段落会被静默跳过，这样列表里留一个空行不影响执行。
 */
export function resolveExecutableSegments(
  segments: Segment[],
  meta: VideoMeta
): Segment[] {
  return segments
    .filter(
      (s) =>
        s.startSec !== null &&
        s.endSec !== null &&
        s.endSec > s.startSec &&
        s.startSec < meta.durationSec
    )
    .map((s) => ({
      ...s,
      endSec: Math.min(s.endSec as number, meta.durationSec),
    }))
}

/** 判断是否具备执行条件 */
export function canRun(
  segments: Segment[],
  meta: VideoMeta | null,
  result: ValidationResult
): boolean {
  if (!meta) return false
  if (result.hasError) return false
  return resolveExecutableSegments(segments, meta).length > 0
}
