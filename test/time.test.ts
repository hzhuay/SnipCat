import { describe, it, expect } from 'vitest'
import { parseTime, formatTime, formatCompact, formatOffset, toFFmpegTime } from '../src/shared/time'

describe('parseTime', () => {
  it('接受纯秒数', () => {
    expect(parseTime('13')).toBe(13)
    expect(parseTime('0')).toBe(0)
    expect(parseTime('90')).toBe(90)
  })

  it('接受 M:SS', () => {
    expect(parseTime('1:30')).toBe(90)
    expect(parseTime('0:05')).toBe(5)
    expect(parseTime('10:00')).toBe(600)
  })

  it('接受 H:MM:SS', () => {
    expect(parseTime('00:00:13')).toBe(13)
    expect(parseTime('00:01:30')).toBe(90)
    expect(parseTime('1:02:03')).toBe(3723)
    expect(parseTime('0:0:0')).toBe(0)
  })

  it('接受小数秒', () => {
    expect(parseTime('1:02:03.5')).toBe(3723.5)
    expect(parseTime('13.25')).toBe(13.25)
    expect(parseTime('0:00.001')).toBe(0.001)
  })

  it('容忍首尾空格和中文冒号', () => {
    expect(parseTime('  1:30  ')).toBe(90)
    expect(parseTime('00：01：30')).toBe(90)
    expect(parseTime('1：30')).toBe(90)
  })

  it('刻意宽松：分段超过 60 也照常累加', () => {
    // 随手敲 1:90 意图明确，强行报错不如按 150 秒处理
    expect(parseTime('1:90')).toBe(150)
  })

  it('拒绝非法输入', () => {
    expect(parseTime('')).toBeNull()
    expect(parseTime('   ')).toBeNull()
    expect(parseTime('abc')).toBeNull()
    expect(parseTime('1:2:3:4')).toBeNull()
    expect(parseTime('-5')).toBeNull()
    expect(parseTime('1:')).toBeNull()
    expect(parseTime(':30')).toBeNull()
    expect(parseTime('1.2.3')).toBeNull()
    expect(parseTime('1:2:333')).toBeNull()
    expect(parseTime('12m30s')).toBeNull()
  })
})

describe('formatTime', () => {
  it('毫秒为 0 时省略小数部分', () => {
    expect(formatTime(0)).toBe('00:00:00')
    expect(formatTime(13)).toBe('00:00:13')
    expect(formatTime(90)).toBe('00:01:30')
    expect(formatTime(3723)).toBe('01:02:03')
  })

  it('保留毫秒', () => {
    expect(formatTime(12.48)).toBe('00:00:12.480')
    expect(formatTime(3723.5)).toBe('01:02:03.500')
    expect(formatTime(0.001)).toBe('00:00:00.001')
  })

  it('抹平浮点误差', () => {
    // 0.1 + 0.2 = 0.30000000000000004，不应显示成 .300000000
    expect(formatTime(0.1 + 0.2)).toBe('00:00:00.300')
    expect(formatTime(12.9999999)).toBe('00:00:13')
  })

  it('超过 1 小时正常进位', () => {
    expect(formatTime(3600)).toBe('01:00:00')
    expect(formatTime(36000)).toBe('10:00:00')
    expect(formatTime(360000)).toBe('100:00:00')
  })

  it('非法输入回退到零', () => {
    expect(formatTime(-1)).toBe('00:00:00')
    expect(formatTime(NaN)).toBe('00:00:00')
    expect(formatTime(Infinity)).toBe('00:00:00')
  })
})

describe('formatCompact', () => {
  it('不足 1 小时用 MM:SS', () => {
    expect(formatCompact(0)).toBe('00:00')
    expect(formatCompact(45)).toBe('00:45')
    expect(formatCompact(122)).toBe('02:02')
    expect(formatCompact(624)).toBe('10:24')
  })

  it('超过 1 小时用 H:MM:SS', () => {
    expect(formatCompact(3600)).toBe('1:00:00')
    expect(formatCompact(3723)).toBe('1:02:03')
  })

  it('四舍五入到整秒', () => {
    expect(formatCompact(44.6)).toBe('00:45')
    expect(formatCompact(624.557267)).toBe('10:25')
  })
})

describe('formatOffset', () => {
  it('带符号显示两位小数', () => {
    expect(formatOffset(-0.52)).toBe('-0.52s')
    expect(formatOffset(0.52)).toBe('+0.52s')
    expect(formatOffset(-1.999)).toBe('-2.00s')
  })

  it('零按负号处理（吸附只会前移或不动）', () => {
    expect(formatOffset(0)).toBe('-0.00s')
  })
})

describe('toFFmpegTime', () => {
  it('固定 3 位小数的纯秒数', () => {
    expect(toFFmpegTime(12.48)).toBe('12.480')
    expect(toFFmpegTime(0)).toBe('0.000')
    expect(toFFmpegTime(3723.5)).toBe('3723.500')
  })
})
