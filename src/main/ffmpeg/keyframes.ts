/**
 * 切点吸附。
 *
 * 流复制（-c copy）只能从关键帧开始，所以切点无法精确落在用户输入的时间上。
 * 这是编码原理决定的物理限制：P/B 帧依赖前面的关键帧，不重编码就无法从任意
 * 帧开始。
 *
 * 吸附方向：**两端都向外**。起点向前、终点向后，宁可多带几帧也不丢内容。
 *
 * 起点为什么要实测而不是推算：在 matroska + B 帧的组合下，ffmpeg 的输入 seek
 * 会落在比「≤目标时间的最近关键帧」更早的位置（实测 mkv 上 `-ss 12` 落到
 * 10.0s，而 12.0s 明明就是关键帧）。mkv 的 seek 以 cluster 为单位，cluster
 * 边界由输入文件决定，无法从关键帧列表推出来。所以直接用同样的 `-ss` 抽一个
 * 包问 ffmpeg 本人，读它的 pts —— 那才是真实落点。
 *
 * 如果只靠推算，UI 会显示「实际 12s」而内容其实从 10s 开始 —— 界面撒谎比
 * 切得不准更糟。
 */

import {
  buildFrameProbeCommand,
  buildKeyframeProbeCommand,
  parseFrameTimes,
  parseKeyframeOutput,
  snapForwardToKeyframe,
  snapToKeyframe,
} from '@shared/commands'
import { requireBinaries } from './locate'
import { runChecked } from './runner'
import type { ProcessHandle } from './runner'

/** 逐级放大的关键帧探测窗口：(向前回看秒数, 窗口长度) */
const WINDOWS: Array<[number, number]> = [
  [6, 12],
  [30, 40],
  [120, 130],
]

/** 一段的吸附结果 */
export interface SnapResult {
  /** 实际起点，总是 ≤ 输入起点 */
  startSec: number
  /** 实际终点，总是 ≥ 输入终点，且不超过视频总时长 */
  endSec: number
}

/** 读取目标时间附近的关键帧列表，窗口不够大时逐级放大 */
async function keyframesAround(
  ffprobe: string,
  filePath: string,
  target: number,
  handle?: ProcessHandle
): Promise<number[]> {
  for (const [back, win] of WINDOWS) {
    handle?.throwIfCanceled()
    const cmd = buildKeyframeProbeCommand(filePath, target, back, win)
    const r = await runChecked(ffprobe, cmd.argv, { handle })
    const kf = parseKeyframeOutput(r.stdout)
    if (kf.length > 0) return kf
    if (target - back <= 0) break
  }
  return []
}

/**
 * 求起点：吸附到 ≤ 输入的最近关键帧。
 *
 * 为什么用 ffprobe 读出的关键帧 pts，而不是实测 ffmpeg 的 `-ss` 落点：
 * 实测落点在 matroska 上不幂等 —— mkv 的 seek 以 cluster 为单位，在关键帧后
 * 约 0.15 秒内会多退一格（实测 `-ss 6.0` 落到 4.0，而 6.0 本身就是关键帧；
 * `-ss 8.12` 落到 6.0）。cluster 边界由输入文件决定，无法推算，所以「用实测
 * 落点当吸附值」永远不可能幂等：输入任何值它都落得更早，反复回填会一路退到 0。
 *
 * 关键帧 pts 列表则与容器无关，snapToKeyframe 按定义幂等
 * （snap(snap(x)) === snap(x)），配合 nudgeAboveMs 的显示取整就能严格往返。
 *
 * 代价：mkv 上那个窄带情况（输入落在关键帧后 0.15s 内）实际会比显示的多切
 * 一格。方向是向外多切，符合「宁可多切几帧、不要缺内容」的取舍。
 *
 * 找不到关键帧时回退到 0 —— 文件开头必然是关键帧，方向仍然向前，只会多带。
 */
async function resolveStart(
  ffprobe: string,
  filePath: string,
  target: number,
  handle?: ProcessHandle
): Promise<number> {
  if (target <= 0) return 0
  const kf = await keyframesAround(ffprobe, filePath, target, handle)
  return snapToKeyframe(kf, target) ?? 0
}

/**
 * 求终点：向后吸附到 >= 输入终点的最近**帧边界**。
 *
 * 终点不受关键帧限制（`-t` 控制输出时长，解码器能停在任意帧），所以吸附到帧
 * 边界而不是关键帧 —— 吸附到关键帧会白多带一整个 GOP。
 *
 * 为什么不能简单地「加一帧余量」：那样每次都会再加一帧，把显示值输回去终点就
 * 越推越后，不幂等。吸附到真实帧边界才满足 snap(snap(x)) === snap(x)。
 *
 * 超过片尾就用视频总时长兜住。
 */
async function resolveEnd(
  ffprobe: string,
  filePath: string,
  target: number,
  durationSec: number,
  handle?: ProcessHandle
): Promise<number> {
  if (target >= durationSec) return durationSec

  handle?.throwIfCanceled()
  const cmd = buildFrameProbeCommand(filePath, target)
  const r = await runChecked(ffprobe, cmd.argv, { handle })
  const frames = parseFrameTimes(r.stdout)
  const forward = snapForwardToKeyframe(frames, target)

  // 找不到更晚的帧说明目标之后就是片尾
  return Math.min(forward ?? durationSec, durationSec)
}

/**
 * 批量求所有段落的吸附结果。
 *
 * 顺序执行而非并发：并发跑多个 ffmpeg/ffprobe 会争抢磁盘 IO，对同一个大文件
 * 反而更慢，而段落通常只有几个，串行总耗时可以接受。
 *
 * 返回的是**真实的帧时间戳**（可能有多位小数）。UI 显示时要用 ceilToMs /
 * floorToMs 向内取整，否则 3 位小数的显示值输回去会破坏幂等性。
 *
 * @param targets 每段的 [起点, 终点]
 * @returns 与 targets 等长的吸附结果数组
 */
export async function snapSegments(
  filePath: string,
  targets: Array<[number, number]>,
  durationSec: number,
  handle?: ProcessHandle
): Promise<SnapResult[]> {
  const { ffprobe } = await requireBinaries()

  const out: SnapResult[] = []
  {
    // 同一时间点只探一次 —— 多段用同样的边界时省掉重复调用
    const startCache = new Map<number, number>()
    const endCache = new Map<number, number>()

    for (const [rawStart, rawEnd] of targets) {
      handle?.throwIfCanceled()

      let start = startCache.get(rawStart)
      if (start === undefined) {
        start = await resolveStart(ffprobe, filePath, rawStart, handle)
        startCache.set(rawStart, start)
      }

      let end = endCache.get(rawEnd)
      if (end === undefined) {
        end = await resolveEnd(ffprobe, filePath, rawEnd, durationSec, handle)
        endCache.set(rawEnd, end)
      }

      // 兜底：极端畸形输入下若出现 end <= start，退回原始终点
      out.push({ startSec: start, endSec: end > start ? end : Math.min(rawEnd, durationSec) })
    }

  }

  return out
}
