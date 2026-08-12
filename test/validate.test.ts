import { describe, it, expect } from 'vitest'
import { validateSegments, resolveExecutableSegments, canRun } from '../src/shared/validate'
import { parseTime } from '../src/shared/time'
import type { Segment } from '../src/shared/types'
import { h264Meta } from './helpers'

/** 按用户输入的原始字符串造一个段落，模拟 UI 的行为 */
function seg(id: string, startRaw: string, endRaw: string): Segment {
  return {
    id,
    startRaw,
    endRaw,
    startSec: parseTime(startRaw),
    endSec: parseTime(endRaw),
  }
}

const meta = h264Meta() // 时长 624.557267s ≈ 10:24.56

function messagesFor(segments: Segment[], id: string): string[] {
  return validateSegments(segments, meta).issues
    .filter((i) => i.segmentId === id)
    .map((i) => i.message)
}

describe('validateSegments — 合法输入', () => {
  it('正常段落无任何问题', () => {
    const r = validateSegments([seg('a', '00:00:13', '00:01:30')], meta)
    expect(r.issues).toEqual([])
    expect(r.hasError).toBe(false)
    expect(r.totalDurationSec).toBe(77)
  })

  it('多段时长累加', () => {
    const r = validateSegments(
      [seg('a', '0:13', '1:30'), seg('b', '2:00', '2:45')],
      meta
    )
    expect(r.hasError).toBe(false)
    expect(r.totalDurationSec).toBe(77 + 45)
  })

  it('空列表不报错', () => {
    const r = validateSegments([], meta)
    expect(r.issues).toEqual([])
    expect(r.hasError).toBe(false)
    expect(r.totalDurationSec).toBe(0)
  })

  it('两个框都空时不报错（刚点添加时的状态）', () => {
    const r = validateSegments([seg('a', '', '')], meta)
    expect(r.issues).toEqual([])
    expect(r.hasError).toBe(false)
  })
})

describe('validateSegments — error 级', () => {
  it('只填了一个框时提示补全', () => {
    expect(messagesFor([seg('a', '0:13', '')], 'a')).toEqual(['请填写终点'])
    expect(messagesFor([seg('a', '', '1:30')], 'a')).toEqual(['请填写起点'])
  })

  it('无法识别的格式', () => {
    expect(messagesFor([seg('a', 'abc', '1:30')], 'a')).toEqual(['起点：无法识别的时间格式'])
    expect(messagesFor([seg('a', '0:13', 'xyz')], 'a')).toEqual(['终点：无法识别的时间格式'])
  })

  it('终点必须晚于起点', () => {
    expect(messagesFor([seg('a', '5:00', '4:00')], 'a')).toEqual(['终点必须晚于起点'])
  })

  it('起止相同也是错误（零长度段落无意义）', () => {
    expect(messagesFor([seg('a', '1:00', '1:00')], 'a')).toEqual(['终点必须晚于起点'])
  })

  it('起点超出视频时长', () => {
    const msgs = messagesFor([seg('a', '20:00', '21:00')], 'a')
    expect(msgs[0]).toContain('起点超出视频时长')
    expect(msgs[0]).toContain('10:25')
  })

  it('存在 error 时 hasError 为 true', () => {
    const r = validateSegments([seg('a', '0:13', '1:30'), seg('b', '5:00', '4:00')], meta)
    expect(r.hasError).toBe(true)
  })

  it('出错的段落不计入总时长', () => {
    const r = validateSegments([seg('a', '0:13', '1:30'), seg('b', '5:00', '4:00')], meta)
    expect(r.totalDurationSec).toBe(77)
  })
})

describe('validateSegments — warning 级', () => {
  it('终点超出时长只警告并截断', () => {
    const r = validateSegments([seg('a', '10:00', '12:00')], meta)
    expect(r.hasError).toBe(false)
    expect(r.issues[0].level).toBe('warning')
    expect(r.issues[0].message).toContain('终点已截断至片尾')
    // 截断到 624.557267，而不是 720
    expect(r.totalDurationSec).toBeCloseTo(624.557267 - 600, 6)
  })

  it('微小的超出在容差内不提示', () => {
    // 视频 624.557267s，填 624.56 只超 0.003s，属于用户按时长顺手填的情况
    const r = validateSegments([seg('a', '10:00', '624.56')], meta)
    expect(r.issues).toEqual([])
  })

  it('段落重叠只警告不阻止（重复使用同一片段是合法需求）', () => {
    const r = validateSegments([seg('a', '0:10', '0:50'), seg('b', '0:30', '1:10')], meta)
    expect(r.hasError).toBe(false)
    const w = r.issues.find((i) => i.segmentId === 'b')
    expect(w?.level).toBe('warning')
    expect(w?.message).toBe('与第 1 段重叠')
  })

  it('完全相同的两段判为重叠', () => {
    const r = validateSegments([seg('a', '0:10', '0:50'), seg('b', '0:10', '0:50')], meta)
    expect(r.issues.some((i) => i.message.includes('重叠'))).toBe(true)
  })

  it('首尾相接不算重叠', () => {
    const r = validateSegments([seg('a', '0:10', '0:50'), seg('b', '0:50', '1:10')], meta)
    expect(r.issues).toEqual([])
  })

  it('重叠只报第一个冲突，避免刷屏', () => {
    const r = validateSegments(
      [seg('a', '0:00', '5:00'), seg('b', '0:10', '4:00'), seg('c', '0:20', '3:00')],
      meta
    )
    expect(r.issues.filter((i) => i.segmentId === 'c')).toHaveLength(1)
  })

  it('乱序不报任何问题（可能是故意的拼接顺序）', () => {
    const r = validateSegments([seg('a', '5:00', '6:00'), seg('b', '1:00', '2:00')], meta)
    expect(r.issues).toEqual([])
  })
})

describe('validateSegments — 无元数据时', () => {
  it('只做段内自洽校验，不检查时长', () => {
    const r = validateSegments([seg('a', '99:00', '100:00')], null)
    expect(r.hasError).toBe(false)
    expect(r.totalDurationSec).toBe(60)
  })

  it('段内错误仍然报出', () => {
    const r = validateSegments([seg('a', '5:00', '4:00')], null)
    expect(r.hasError).toBe(true)
  })
})

describe('resolveExecutableSegments', () => {
  it('跳过空白和非法段落', () => {
    const segs = [
      seg('a', '0:13', '1:30'),
      seg('b', '', ''),
      seg('c', 'abc', '1:00'),
      seg('d', '5:00', '4:00'),
      seg('e', '2:00', '2:45'),
    ]
    const r = resolveExecutableSegments(segs, meta)
    expect(r.map((s) => s.id)).toEqual(['a', 'e'])
  })

  it('把终点截断到视频时长内', () => {
    const r = resolveExecutableSegments([seg('a', '10:00', '12:00')], meta)
    expect(r[0].endSec).toBeCloseTo(624.557267, 6)
  })

  it('保持列表顺序', () => {
    const r = resolveExecutableSegments([seg('a', '5:00', '6:00'), seg('b', '1:00', '2:00')], meta)
    expect(r.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('不改写原对象', () => {
    const segs = [seg('a', '10:00', '12:00')]
    resolveExecutableSegments(segs, meta)
    expect(segs[0].endSec).toBe(720)
  })
})

describe('canRun', () => {
  it('有合法段落且无错误时可执行', () => {
    const segs = [seg('a', '0:13', '1:30')]
    expect(canRun(segs, meta, validateSegments(segs, meta))).toBe(true)
  })

  it('未选文件时不可执行', () => {
    const segs = [seg('a', '0:13', '1:30')]
    expect(canRun(segs, null, validateSegments(segs, null))).toBe(false)
  })

  it('存在 error 时不可执行', () => {
    const segs = [seg('a', '0:13', '1:30'), seg('b', '5:00', '4:00')]
    expect(canRun(segs, meta, validateSegments(segs, meta))).toBe(false)
  })

  it('全是空白段落时不可执行', () => {
    const segs = [seg('a', '', '')]
    expect(canRun(segs, meta, validateSegments(segs, meta))).toBe(false)
  })

  it('只有 warning 时仍可执行', () => {
    const segs = [seg('a', '0:10', '0:50'), seg('b', '0:30', '1:10')]
    const r = validateSegments(segs, meta)
    expect(r.issues.length).toBeGreaterThan(0)
    expect(canRun(segs, meta, r)).toBe(true)
  })
})
