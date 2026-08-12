/**
 * 时间字符串的解析与格式化。
 *
 * 纯函数，不依赖 Electron 或 ffmpeg，可以直接单测。
 */

/** 解析时能接受的最大冒号分段数（时:分:秒） */
const MAX_PARTS = 3

/**
 * 宽松解析时间字符串为秒数。冒号分段从右往左依次是秒、分、时。
 *
 * 接受：`13` → 13、`1:30` → 90、`00:00:13` → 13、`1:02:03.5` → 3723.5
 * 也容忍中文冒号和首尾空格。
 *
 * 刻意宽松：`1:90` 会得到 150 秒而不是报错，因为逐段累加比强行校验
 * 每段 < 60 更符合"随手敲一个时间"的使用场景。
 *
 * @returns 秒数，无法解析时返回 null
 */
export function parseTime(input: string): number | null {
  const t = input.trim().replace(/：/g, ':')
  if (!t) return null

  // 整体形状校验：数字开头，若干个 :数字 分段，可选的小数尾部
  if (!/^\d+(:\d{1,2})*(\.\d+)?$/.test(t)) return null

  const parts = t.split(':')
  if (parts.length > MAX_PARTS) return null

  let sec = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isFinite(n)) return null
    sec = sec * 60 + n
  }

  return Number.isFinite(sec) ? sec : null
}

/**
 * 格式化秒数为 `HH:MM:SS.mmm`，毫秒为 0 时省略小数部分。
 *
 * 用于输入框失焦后的规范化显示，以及展示关键帧吸附后的实际切点。
 */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00:00'

  // 先按毫秒取整，避免浮点误差让 12.9999999 显示成 12.999
  const totalMs = Math.round(sec * 1000)
  const ms = totalMs % 1000
  const totalSec = (totalMs - ms) / 1000
  const s = totalSec % 60
  const totalMin = (totalSec - s) / 60
  const m = totalMin % 60
  const h = (totalMin - m) / 60

  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  const base = `${hh}:${mm}:${ss}`

  return ms === 0 ? base : `${base}.${String(ms).padStart(3, '0')}`
}

/**
 * 紧凑格式化时长，用于展示段落时长和总时长。
 *
 * 不足 1 小时显示 `MM:SS`，超过则显示 `H:MM:SS`。
 */
export function formatCompact(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00'

  const totalSec = Math.round(sec)
  const s = totalSec % 60
  const totalMin = (totalSec - s) / 60
  const m = totalMin % 60
  const h = (totalMin - m) / 60

  const ss = String(s).padStart(2, '0')
  if (h === 0) return `${String(m).padStart(2, '0')}:${ss}`
  return `${h}:${String(m).padStart(2, '0')}:${ss}`
}

/**
 * 带符号地格式化偏移量，用于展示关键帧吸附造成的漂移，如 `-0.52s`。
 */
export function formatOffset(deltaSec: number): string {
  const sign = deltaSec > 0 ? '+' : '-'
  return `${sign}${Math.abs(deltaSec).toFixed(2)}s`
}

/**
 * 把秒数格式化为 ffmpeg 命令行参数用的时间字符串。
 *
 * 用固定 3 位小数的纯秒数形式（如 `12.480`）而不是 `HH:MM:SS`：
 * ffmpeg 两种都接受，但纯秒数在日志和 Dry-run 面板里更容易和吸附结果对照。
 */
export function toFFmpegTime(sec: number): string {
  return sec.toFixed(3)
}

/**
 * 向上取整到毫秒。
 */
export function ceilToMs(sec: number): number {
  // +0 而不是 -0：Math.ceil(-1e-9) 返回 -0，会让 Object.is 相等判断失败
  return Math.ceil(sec * 1000 - 1e-9) / 1000 + 0
}

/**
 * 向下取整到毫秒。
 *
 * 用于**显示终点**：终点是向后吸附的，显示值 ≤ 真实边界才能保证回填后仍向后
 * 吸附到同一个边界。
 */
export function floorToMs(sec: number): number {
  return Math.floor(sec * 1000 + 1e-9) / 1000
}

/**
 * 取严格大于 sec 的最小毫秒值。
 *
 * 用于**显示起点**。为什么必须严格大于而不是简单地向上取整：ffmpeg 在不同容器
 * 上的 seek 语义不一致 ——
 *   - mp4：落到 `≤ 目标` 的最近关键帧（目标正好是关键帧时不动，幂等）
 *   - matroska：落到 `< 目标` 的最近关键帧（目标正好是关键帧时**再退一格**）
 *
 * 实测 mkv 上 `-ss 8.0` 落到 6.0，而 8.0 本身就是关键帧。所以若把落点原样显示、
 * 用户再输回去，mkv 上每次都会再退一个 GOP。显示值取「严格大于落点的最小毫秒」
 * 就同时满足两种语义：它大于落点（mkv 不会再退），又小于下一个关键帧（mp4 仍
 * 落回同一处）。
 *
 * 代价是显示值比真实落点最多晚 1 毫秒 —— 远小于一帧（30fps 为 33ms），
 * 换来的是数值可往返。
 */
export function nudgeAboveMs(sec: number): number {
  return floorToMs(sec) + 0.001
}
