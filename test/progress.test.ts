import { describe, it, expect } from 'vitest'
import {
  ProgressParser,
  parseFFmpegOutTime,
  overallRatio,
  estimateEta,
  COPY_WEIGHTS,
} from '../src/shared/progress'

describe('ProgressParser', () => {
  it('解析一个完整的 progress 块', () => {
    const p = new ProgressParser()
    const chunk = [
      'frame=750',
      'fps=250.0',
      'bitrate=5000.0kbits/s',
      'total_size=15625000',
      'out_time_us=25000000',
      'out_time_ms=25000000',
      'out_time=00:00:25.000000',
      'speed=8.33x',
      'progress=continue',
      '',
    ].join('\n')

    const updates = p.push(chunk)
    expect(updates).toHaveLength(1)
    // out_time_us 单位是微秒 → 25 秒
    expect(updates[0].outTimeSec).toBe(25)
    expect(updates[0].ended).toBe(false)
  })

  it('out_time_ms 的单位实际也是微秒（ffmpeg 历史遗留）', () => {
    const p = new ProgressParser()
    // 旧版 ffmpeg 只给 out_time_ms，值 25000000 应解释成 25 秒而非 25000 秒
    const updates = p.push('out_time_ms=25000000\nprogress=continue\n')
    expect(updates[0].outTimeSec).toBe(25)
  })

  it('识别 progress=end', () => {
    const p = new ProgressParser()
    const updates = p.push('out_time_us=77520000\nprogress=end\n')
    expect(updates[0].outTimeSec).toBeCloseTo(77.52, 6)
    expect(updates[0].ended).toBe(true)
  })

  it('缓冲跨 chunk 的半行', () => {
    const p = new ProgressParser()
    // 第一次收到不完整的行
    expect(p.push('out_time_us=250')).toEqual([])
    // 补齐后才产出更新
    const updates = p.push('00000\nprogress=continue\n')
    expect(updates).toHaveLength(1)
    expect(updates[0].outTimeSec).toBe(25)
  })

  it('一次 chunk 含多个 progress 块', () => {
    const p = new ProgressParser()
    const chunk =
      'out_time_us=1000000\nprogress=continue\n' +
      'out_time_us=2000000\nprogress=continue\n' +
      'out_time_us=3000000\nprogress=end\n'
    const updates = p.push(chunk)
    expect(updates.map((u) => u.outTimeSec)).toEqual([1, 2, 3])
    expect(updates.map((u) => u.ended)).toEqual([false, false, true])
  })

  it('只有 out_time 时回退解析它', () => {
    const p = new ProgressParser()
    const updates = p.push('out_time=00:01:17.520000\nprogress=continue\n')
    expect(updates[0].outTimeSec).toBeCloseTo(77.52, 3)
  })

  it('out_time_us 存在时优先于 out_time', () => {
    const p = new ProgressParser()
    const updates = p.push('out_time_us=25000000\nout_time=99:99:99.0\nprogress=continue\n')
    expect(updates[0].outTimeSec).toBe(25)
  })

  it('忽略无关行和 N/A 值', () => {
    const p = new ProgressParser()
    const updates = p.push(
      'garbage line without equals\nout_time_us=N/A\nout_time_us=5000000\nprogress=continue\n'
    )
    expect(updates).toHaveLength(1)
    expect(updates[0].outTimeSec).toBe(5)
  })

  it('没有时间信息的块产出 0 而不是崩溃', () => {
    const p = new ProgressParser()
    const updates = p.push('frame=0\nprogress=continue\n')
    expect(updates).toEqual([{ outTimeSec: 0, ended: false }])
  })

  it('reset 清空缓冲', () => {
    const p = new ProgressParser()
    p.push('out_time_us=250')
    p.reset()
    // 之前的半行被丢弃，不会和新数据粘连成错误的值
    expect(p.push('00000\nprogress=continue\n')).toEqual([{ outTimeSec: 0, ended: false }])
  })
})

describe('parseFFmpegOutTime', () => {
  it('解析 HH:MM:SS.mmm', () => {
    expect(parseFFmpegOutTime('00:00:25.000000')).toBe(25)
    expect(parseFFmpegOutTime('01:02:03.500000')).toBeCloseTo(3723.5, 6)
    expect(parseFFmpegOutTime('00:00:00.000000')).toBe(0)
  })

  it('接受不带小数的形式', () => {
    expect(parseFFmpegOutTime('00:00:25')).toBe(25)
  })

  it('非法值返回 null', () => {
    expect(parseFFmpegOutTime('N/A')).toBeNull()
    expect(parseFFmpegOutTime('')).toBeNull()
    expect(parseFFmpegOutTime('-00:00:01.0')).toBeNull()
  })
})

describe('overallRatio', () => {
  it('切分阶段按权重折算', () => {
    // 总 100 秒，已完成 50 秒，拼接未开始 → 0.5 * 0.9
    expect(overallRatio(50, 0, 100, 0, COPY_WEIGHTS)).toBeCloseTo(0.45, 6)
  })

  it('计入当前段的进度', () => {
    expect(overallRatio(40, 10, 100, 0, COPY_WEIGHTS)).toBeCloseTo(0.45, 6)
  })

  it('切分完成拼接未开始时是 0.9', () => {
    expect(overallRatio(100, 0, 100, 0, COPY_WEIGHTS)).toBeCloseTo(0.9, 6)
  })

  it('全部完成是 1', () => {
    expect(overallRatio(100, 0, 100, 100, COPY_WEIGHTS)).toBeCloseTo(1, 6)
  })

  it('总时长为 0 时返回 0 而不是 NaN', () => {
    expect(overallRatio(0, 0, 0, 0, COPY_WEIGHTS)).toBe(0)
  })

  it('结果被夹在 [0,1]（ffmpeg 报告的时间可能略超预期）', () => {
    expect(overallRatio(120, 10, 100, 200, COPY_WEIGHTS)).toBe(1)
    expect(overallRatio(-5, 0, 100, 0, COPY_WEIGHTS)).toBe(0)
  })
})

describe('estimateEta', () => {
  it('按已用时线性外推', () => {
    // 10 秒跑完 50%，预计还要 10 秒
    expect(estimateEta(10, 0.5)).toBeCloseTo(10, 6)
    expect(estimateEta(30, 0.75)).toBeCloseTo(10, 6)
  })

  it('进度过小时不给估计（不准且抖动大）', () => {
    expect(estimateEta(1, 0.01)).toBeUndefined()
    expect(estimateEta(1, 0)).toBeUndefined()
  })

  it('完成后不给估计', () => {
    expect(estimateEta(10, 1)).toBeUndefined()
  })
})
