import { describe, it, expect } from 'vitest'
import { snapDisplay } from '../src/shared/interaction'
import { ceilToMs, floorToMs, nudgeAboveMs, formatTime, parseTime } from '../src/shared/time'
import type { Segment } from '../src/shared/types'

/** 30fps 的单帧时长 */
const FRAME_30 = 1 / 30

function seg(
  startSec: number,
  endSec: number,
  snappedStartSec?: number,
  snappedEndSec?: number
): Segment {
  return {
    id: 's',
    startRaw: formatTime(startSec),
    endRaw: formatTime(endSec),
    startSec,
    endSec,
    snappedStartSec,
    snappedEndSec,
  }
}

describe('nudgeAboveMs', () => {
  it('取严格大于输入的最小毫秒值', () => {
    // 必须严格大于：mkv 的 -ss 落在关键帧上时会再退一格，等于就不幂等了
    expect(nudgeAboveMs(9.5095)).toBeCloseTo(9.51, 9)
    expect(nudgeAboveMs(8)).toBeCloseTo(8.001, 9)
    expect(nudgeAboveMs(0)).toBeCloseTo(0.001, 9)
  })

  it('结果始终大于输入', () => {
    for (const v of [0, 1.001, 8, 9.5095, 12.4567, 15.4154]) {
      expect(nudgeAboveMs(v)).toBeGreaterThan(v)
    }
  })

  it('偏移不超过 1 毫秒（远小于一帧）', () => {
    for (const v of [0, 8, 9.5095, 15.4154]) {
      expect(nudgeAboveMs(v) - v).toBeLessThanOrEqual(0.001 + 1e-9)
    }
  })
})

describe('ceilToMs / floorToMs', () => {
  it('向上 / 向下取整到毫秒', () => {
    expect(ceilToMs(9.5095)).toBe(9.51)
    expect(floorToMs(9.5095)).toBe(9.509)
  })

  it('已经是整毫秒时不动（避免无谓地多跳 1ms）', () => {
    expect(ceilToMs(9.51)).toBe(9.51)
    expect(floorToMs(9.509)).toBe(9.509)
    expect(ceilToMs(12)).toBe(12)
    expect(floorToMs(12)).toBe(12)
  })

  it('容忍浮点表示误差', () => {
    // 0.1+0.2 = 0.30000000000000004，不该被向上推到 0.301
    expect(ceilToMs(0.1 + 0.2)).toBeCloseTo(0.3, 9)
    expect(floorToMs(0.1 + 0.2)).toBeCloseTo(0.3, 9)
  })

  it('零和整数秒', () => {
    expect(ceilToMs(0)).toBe(0)
    expect(floorToMs(0)).toBe(0)
  })
})

describe('snapDisplay — 幂等性（用户报告的 bug）', () => {
  /**
   * 复现场景：29.97fps 的视频，关键帧真实 pts 是 9.5095。
   * 旧实现按四舍五入显示 9.509，用户把它输回去时比真关键帧早 0.5ms，
   * ffmpeg 只能再退一整个 GOP —— 显示值破坏了吸附的幂等性。
   */
  it('起点显示值严格大于真实落点，回填后不会再往前跳', () => {
    const d = snapDisplay(seg(9.88, 15, 9.5095, 15), FRAME_30)
    expect(d).not.toBeNull()
    // 9.51 > 9.5095：mp4 上仍落回同一关键帧，mkv 上也不会再退一格
    expect(d!.startSec).toBeCloseTo(9.51, 9)
    expect(d!.startSec).toBeGreaterThan(9.5095)
  })

  it('落点正好是整毫秒时也严格大于（mkv 的关键场景）', () => {
    // mkv 上 -ss 8.0 会落到 6.0，所以显示值必须是 8.001 而不是 8.000
    const d = snapDisplay(seg(9.88, 15, 8, 15), FRAME_30)!
    expect(d.startSec).toBeGreaterThan(8)
    expect(d.startSec).toBeCloseTo(8.001, 9)
  })

  it('终点显示值向下取整，回填后不会晚于真实帧边界', () => {
    const d = snapDisplay(seg(5, 9.88, 5, 9.5095), FRAME_30)
    // 9.509 ≤ 9.5095，回填后仍向后吸附到同一个边界
    expect(d!.endSec).toBeCloseTo(9.509, 9)
    expect(d!.endSec).toBeLessThanOrEqual(9.5095)
  })

  it('把显示值当作新输入时，多切量收敛到 0（不再反复外扩）', () => {
    // 第一轮：用户输入 9.88，落点 9.5095
    const first = snapDisplay(seg(9.88, 20, 9.5095, 20), FRAME_30)!
    expect(first.headExtra).toBeCloseTo(9.88 - 9.51, 6)

    // 第二轮：用户把显示的 9.51 输回去，吸附仍是 9.5095（幂等）
    const second = snapDisplay(seg(first.startSec, 20, 9.5095, 20), FRAME_30)!
    expect(second.startSec).toBeCloseTo(9.51, 9)
    // 关键：不再提示多切 —— 旧实现这里会显示又多切了 0.5s
    expect(second.headExtra).toBeLessThan(FRAME_30 / 2)
    expect(second.drifted).toBe(false)
  })

  it('显示值经 formatTime → parseTime 往返后不变', () => {
    const d = snapDisplay(seg(9.88, 15, 9.5095, 15), FRAME_30)!
    // 界面显示 3 位小数，parseTime 读回来必须还是同一个数
    expect(parseTime(formatTime(d.startSec))).toBe(d.startSec)
    expect(parseTime(formatTime(d.endSec))).toBe(d.endSec)
  })
})

describe('snapDisplay — 两端一视同仁', () => {
  it('只有终点多切时同样会提示（旧实现这里不提示）', () => {
    // 起点正好在关键帧上，终点向后扩了 0.4s
    const d = snapDisplay(seg(10, 20, 10, 20.4), FRAME_30)!
    expect(d.headExtra).toBe(0)
    expect(d.tailExtra).toBeCloseTo(0.4, 6)
    expect(d.drifted).toBe(true)
  })

  it('只有起点多切时提示', () => {
    const d = snapDisplay(seg(10, 20, 9.5, 20), FRAME_30)!
    // 0.499 而非 0.5：显示值比落点晚 1ms（见 nudgeAboveMs），多切量按显示值算
    expect(d.headExtra).toBeCloseTo(0.499, 6)
    expect(d.tailExtra).toBe(0)
    expect(d.drifted).toBe(true)
  })

  it('两端都多切时都计算', () => {
    const d = snapDisplay(seg(10, 20, 9.5, 20.5), FRAME_30)!
    expect(d.headExtra).toBeCloseTo(0.499, 6)
    expect(d.tailExtra).toBeCloseTo(0.5, 6)
    expect(d.drifted).toBe(true)
  })

  it('阈值是半帧，两端用同一个标准', () => {
    const halfFrame = FRAME_30 / 2
    // 略小于半帧 → 不提示
    const small = snapDisplay(seg(10, 20, 10 - halfFrame * 0.9, 20), FRAME_30)!
    expect(small.drifted).toBe(false)
    // 略大于半帧 → 提示
    const big = snapDisplay(seg(10, 20, 10 - halfFrame * 1.5, 20), FRAME_30)!
    expect(big.drifted).toBe(true)

    // 终点侧同理
    const smallTail = snapDisplay(seg(10, 20, 10, 20 + halfFrame * 0.9), FRAME_30)!
    expect(smallTail.drifted).toBe(false)
    const bigTail = snapDisplay(seg(10, 20, 10, 20 + halfFrame * 1.5), FRAME_30)!
    expect(bigTail.drifted).toBe(true)
  })

  it('高帧率视频的阈值更小（60fps 半帧 ≈ 8ms）', () => {
    const frame60 = 1 / 60
    // 12ms 的多切在 30fps 下不提示，在 60fps 下要提示
    expect(snapDisplay(seg(10, 20, 9.988, 20), FRAME_30)!.drifted).toBe(false)
    expect(snapDisplay(seg(10, 20, 9.988, 20), frame60)!.drifted).toBe(true)
  })
})

describe('snapDisplay — 边界情况', () => {
  it('多切量不为负（吸附方向反了也不显示负数）', () => {
    // 理论上不该发生，但兜住：起点吸附到更晚的位置
    const d = snapDisplay(seg(10, 20, 10.5, 19.5), FRAME_30)!
    expect(d.headExtra).toBe(0)
    expect(d.tailExtra).toBe(0)
  })

  it('显示的起点不会晚于用户输入的起点', () => {
    // 落点几乎等于输入时，nudge 后可能超过输入 —— 要夹住，否则"实际"晚于"请求"很怪
    const d = snapDisplay(seg(10, 20, 10, 20), FRAME_30)!
    expect(d.startSec).toBeLessThanOrEqual(10)
  })

  it('没有任何吸附结果时返回 null', () => {
    expect(snapDisplay(seg(10, 20), FRAME_30)).toBeNull()
  })

  it('只有起点吸附时，终点用原值', () => {
    const d = snapDisplay(seg(10, 20, 9.5), FRAME_30)!
    expect(d.endSec).toBeCloseTo(20, 9)
    expect(d.tailExtra).toBe(0)
  })

  it('时间未解析时返回 null', () => {
    const bad: Segment = {
      id: 's',
      startRaw: 'abc',
      endRaw: '20',
      startSec: null,
      endSec: 20,
      snappedStartSec: 9.5,
    }
    expect(snapDisplay(bad, FRAME_30)).toBeNull()
  })
})
