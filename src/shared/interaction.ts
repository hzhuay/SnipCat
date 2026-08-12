/**
 * UI 交互的判定逻辑。
 *
 * 纯函数：输入当前段落列表和播放位置，输出「该做什么」。这样交互规则可以
 * 直接单测，而不用去驱动 React 组件。
 */

import type { Segment } from './types'
import { floorToMs, nudgeAboveMs } from './time'

/** 回车键的智能判定结果 */
export type EnterAction =
  /** 给某个已有起点的段落补上终点 */
  | { kind: 'setEnd'; segmentId: string }
  /** 填入某个空行的起点 */
  | { kind: 'setStart'; segmentId: string }
  /** 新建一段并填入起点 */
  | { kind: 'addWithStart' }
  /** 无效操作，附带原因用于提示 */
  | { kind: 'invalid'; reason: string }

/**
 * 一段的吸附展示信息。
 *
 * 显示值不是真实落点的原样，而是各向内挪不到 1 毫秒：起点用 nudgeAboveMs、
 * 终点用 floorToMs。这样把显示值输回输入框时，吸附结果不变（幂等）。
 * 详细原因见 nudgeAboveMs 的注释 —— 核心是 mp4 与 matroska 的 seek 语义不同，
 * mkv 上 `-ss` 落在关键帧上时会再退一格。
 */
export interface SnapDisplay {
  /** 显示用的实际起点，回填后吸附结果不变 */
  startSec: number
  /** 显示用的实际终点，回填后吸附结果不变 */
  endSec: number
  /** 头部多切的秒数（≥ 0） */
  headExtra: number
  /** 尾部多切的秒数（≥ 0） */
  tailExtra: number
  /** 是否有值得提示的多切（任一端超过半帧） */
  drifted: boolean
}

/**
 * 计算一段的吸附展示信息。
 *
 * 阈值取半帧：两端用同一套规则，小于半帧的差异在视觉上无意义，不值得提示。
 * 这也让「把显示值输回去」的第二轮不再提示多切 —— 此时的差异只有 1 毫秒。
 *
 * @param seg 段落（需要已有 snappedStartSec / snappedEndSec）
 * @param frameDurationSec 单帧时长，用于计算提示阈值
 */
export function snapDisplay(seg: Segment, frameDurationSec: number): SnapDisplay | null {
  if (seg.startSec === null || seg.endSec === null) return null
  if (seg.snappedStartSec === undefined && seg.snappedEndSec === undefined) return null

  const rawStart = seg.snappedStartSec ?? seg.startSec
  const rawEnd = seg.snappedEndSec ?? seg.endSec

  // 起点不能超过用户输入的起点，否则显示"实际"晚于"请求"会很怪
  const startSec = Math.min(nudgeAboveMs(rawStart), floorToMs(seg.startSec))
  const endSec = floorToMs(rawEnd)

  // 用取整后的显示值算多切量，这样界面上的数字和文案自洽
  const headExtra = Math.max(0, seg.startSec - startSec)
  const tailExtra = Math.max(0, endSec - seg.endSec)
  const threshold = frameDurationSec / 2

  return {
    startSec,
    endSec,
    headExtra,
    tailExtra,
    drifted: headExtra > threshold || tailExtra > threshold,
  }
}

/**
 * 判定回车键该做什么。
 *
 * 规则（按优先级）：
 * 1. 存在「只有起点、缺终点」的段落时，优先补终点 —— 但当前位置必须在该起点
 *    之后才构成合法区间；否则视为无效操作，不做任何改动。
 *    这条优先级最高：有半截的段落挂着时，不该悄悄去开新的一段。
 * 2. 所有段落都完整时，视为要开始标一个新段：填进空行，或新建一行。
 *
 * @param segments 当前列表
 * @param currentSec 播放头位置
 */
export function resolveEnterAction(segments: Segment[], currentSec: number): EnterAction {
  // 只有起点、还缺终点的段落。取最后一个 —— 用户通常在标最新的那段。
  const pending = [...segments]
    .reverse()
    .find((s) => s.startSec !== null && s.endRaw.trim() === '')

  if (pending) {
    if (currentSec > (pending.startSec as number)) {
      return { kind: 'setEnd', segmentId: pending.id }
    }
    return {
      kind: 'invalid',
      reason: '当前位置在未完成段落的起点之前，无法作为终点',
    }
  }

  // 所有段落都完整（或为空行），开始标新的一段
  const emptyRow = segments.find((s) => s.startRaw.trim() === '' && s.endRaw.trim() === '')
  if (emptyRow) return { kind: 'setStart', segmentId: emptyRow.id }

  return { kind: 'addWithStart' }
}
