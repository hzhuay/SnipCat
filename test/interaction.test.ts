import { describe, it, expect } from 'vitest'
import { resolveEnterAction } from '../src/shared/interaction'
import type { Segment } from '../src/shared/types'
import { parseTime } from '../src/shared/time'

function seg(id: string, startRaw: string, endRaw: string): Segment {
  return {
    id,
    startRaw,
    endRaw,
    startSec: parseTime(startRaw),
    endSec: parseTime(endRaw),
  }
}

describe('resolveEnterAction — 补终点（优先级最高）', () => {
  it('存在只有起点的段落且当前位置在其后 → 设终点', () => {
    const segs = [seg('a', '0:10', '')]
    expect(resolveEnterAction(segs, 20)).toEqual({ kind: 'setEnd', segmentId: 'a' })
  })

  it('当前位置在起点之前 → 无效操作，不做任何改动', () => {
    const segs = [seg('a', '0:30', '')]
    const r = resolveEnterAction(segs, 10)
    expect(r.kind).toBe('invalid')
    if (r.kind === 'invalid') expect(r.reason).toContain('起点之前')
  })

  it('当前位置正好等于起点 → 无效（零长度段落无意义）', () => {
    const segs = [seg('a', '0:10', '')]
    expect(resolveEnterAction(segs, 10).kind).toBe('invalid')
  })

  it('有多个待补终点的段落时取最后一个（用户通常在标最新的）', () => {
    const segs = [seg('a', '0:10', ''), seg('b', '1:00', '')]
    expect(resolveEnterAction(segs, 70)).toEqual({ kind: 'setEnd', segmentId: 'b' })
  })

  it('待补段落优先于空行：不悄悄去开新的一段', () => {
    const segs = [seg('a', '0:10', ''), seg('b', '', '')]
    expect(resolveEnterAction(segs, 20)).toEqual({ kind: 'setEnd', segmentId: 'a' })
  })

  it('待补段落位置不合法时，即使有空行也报无效', () => {
    // 有半截的段落挂着，就该先解决它，而不是绕过去用空行
    const segs = [seg('a', '0:30', ''), seg('b', '', '')]
    expect(resolveEnterAction(segs, 10).kind).toBe('invalid')
  })

  it('起点非法（无法解析）的段落不算待补', () => {
    const segs = [seg('a', 'abc', ''), seg('b', '', '')]
    expect(resolveEnterAction(segs, 20)).toEqual({ kind: 'setStart', segmentId: 'b' })
  })
})

describe('resolveEnterAction — 设起点', () => {
  it('所有段落完整且有空行 → 填入空行的起点', () => {
    const segs = [seg('a', '0:10', '0:20'), seg('b', '', '')]
    expect(resolveEnterAction(segs, 30)).toEqual({ kind: 'setStart', segmentId: 'b' })
  })

  it('所有段落完整且无空行 → 新建一段', () => {
    const segs = [seg('a', '0:10', '0:20')]
    expect(resolveEnterAction(segs, 30)).toEqual({ kind: 'addWithStart' })
  })

  it('空列表 → 新建一段', () => {
    expect(resolveEnterAction([], 30)).toEqual({ kind: 'addWithStart' })
  })

  it('只有一个空行 → 填它', () => {
    const segs = [seg('a', '', '')]
    expect(resolveEnterAction(segs, 30)).toEqual({ kind: 'setStart', segmentId: 'a' })
  })

  it('有多个空行时填第一个', () => {
    const segs = [seg('a', '', ''), seg('b', '', '')]
    expect(resolveEnterAction(segs, 30)).toEqual({ kind: 'setStart', segmentId: 'a' })
  })

  it('新起点在已有段落之前也允许（顺序不限制）', () => {
    // 段落顺序即拼接顺序，用户可能故意倒序标记
    const segs = [seg('a', '1:00', '2:00')]
    expect(resolveEnterAction(segs, 10)).toEqual({ kind: 'addWithStart' })
  })
})

describe('resolveEnterAction — 连续按回车的完整流程', () => {
  it('标 → 补 → 标 → 补', () => {
    // 空列表，第一次回车在 10s
    let segs: Segment[] = [seg('a', '', '')]
    expect(resolveEnterAction(segs, 10)).toEqual({ kind: 'setStart', segmentId: 'a' })

    // 起点已填，第二次回车在 20s → 补终点
    segs = [seg('a', '0:10', '')]
    expect(resolveEnterAction(segs, 20)).toEqual({ kind: 'setEnd', segmentId: 'a' })

    // 第一段完整，第三次回车在 30s → 新建
    segs = [seg('a', '0:10', '0:20')]
    expect(resolveEnterAction(segs, 30)).toEqual({ kind: 'addWithStart' })

    // 新段起点已填，第四次回车在 40s → 补终点
    segs = [seg('a', '0:10', '0:20'), seg('b', '0:30', '')]
    expect(resolveEnterAction(segs, 40)).toEqual({ kind: 'setEnd', segmentId: 'b' })
  })
})
