/**
 * ffmpeg `-progress pipe:1` 输出的解析。
 *
 * 加了 `-progress pipe:1 -nostats` 后，ffmpeg 往 stdout 输出 key=value 行，
 * 每个块以 `progress=continue` 结束、最后一块是 `progress=end`。
 *
 * 做成有状态的小类而不是纯函数，因为 stdout 是流式到达的，一次 data 事件
 * 可能收到半行 —— 必须缓冲未完成的行。
 */

/** 一次进度更新 */
export interface ProgressUpdate {
  /** 已输出的时长（秒） */
  outTimeSec: number
  /** 是否是最后一块（progress=end） */
  ended: boolean
}

export class ProgressParser {
  private buf = ''

  /**
   * 喂入一段 stdout 文本，返回其中包含的所有进度更新。
   *
   * ffmpeg 的一个历史遗留坑：`out_time_ms` 这个 key 的单位实际是**微秒**而非毫秒。
   * 新版改名成了 `out_time_us`，但旧版仍在用 `out_time_ms`，且两者单位相同。
   * 所以两个 key 都按微秒处理。
   */
  push(chunk: string): ProgressUpdate[] {
    this.buf += chunk
    const lines = this.buf.split('\n')
    // 最后一段可能是不完整的行，留到下次
    this.buf = lines.pop() ?? ''

    const updates: ProgressUpdate[] = []
    let pending: number | null = null

    for (const line of lines) {
      const i = line.indexOf('=')
      if (i < 0) continue
      const key = line.slice(0, i).trim()
      const value = line.slice(i + 1).trim()

      if (key === 'out_time_us' || key === 'out_time_ms') {
        const us = Number(value)
        if (Number.isFinite(us) && us >= 0) pending = us / 1e6
      } else if (key === 'out_time') {
        // 备用：HH:MM:SS.mmm 形式，某些版本只给这个
        if (pending === null) {
          const sec = parseFFmpegOutTime(value)
          if (sec !== null) pending = sec
        }
      } else if (key === 'progress') {
        updates.push({ outTimeSec: pending ?? 0, ended: value === 'end' })
        pending = null
      }
    }

    return updates
  }

  /** 重置状态，用于复用同一个 parser 处理下一条命令 */
  reset(): void {
    this.buf = ''
  }
}

/** 解析 ffmpeg 的 `out_time` 值（HH:MM:SS.mmm） */
export function parseFFmpegOutTime(v: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v.trim())
  if (!m) return null
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(sec) ? sec : null
}

/**
 * 多阶段任务的整体进度加权。
 *
 * 流复制的拼接步骤极快（纯容器层操作），所以切分占 90%、拼接占 10%。
 */
export interface ProgressWeights {
  cut: number
  concat: number
}

export const COPY_WEIGHTS: ProgressWeights = { cut: 0.9, concat: 0.1 }
/** 重编码模式（精确/压缩）下切分是重编码，耗时占绝对主导 */
export const RECODE_WEIGHTS: ProgressWeights = { cut: 0.97, concat: 0.03 }

/**
 * 计算整体进度比例。
 *
 * @param completedCutSec 已完成段落的时长之和
 * @param currentCutSec 当前段落已处理的时长
 * @param totalCutSec 所有段落时长之和
 * @param concatSec 拼接阶段已处理的时长（未进入该阶段传 0）
 * @param weights 阶段权重
 */
export function overallRatio(
  completedCutSec: number,
  currentCutSec: number,
  totalCutSec: number,
  concatSec: number,
  weights: ProgressWeights
): number {
  if (totalCutSec <= 0) return 0
  const cutRatio = Math.min(1, (completedCutSec + currentCutSec) / totalCutSec)
  const concatRatio = Math.min(1, concatSec / totalCutSec)
  const r = cutRatio * weights.cut + concatRatio * weights.concat
  return Math.max(0, Math.min(1, r))
}

/** 根据已用时和进度估算剩余秒数；进度过小时不给估计（不准且抖动大） */
export function estimateEta(elapsedSec: number, ratio: number): number | undefined {
  if (ratio < 0.02 || ratio >= 1) return undefined
  return Math.max(0, (elapsedSec / ratio) * (1 - ratio))
}
