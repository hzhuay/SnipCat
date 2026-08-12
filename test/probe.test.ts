import { describe, it, expect } from 'vitest'
import { parseProbeOutput, frameRateToNumber, describeMeta, formatBytes } from '../src/shared/probe'
import { h264Meta, hevcMeta } from './helpers'

describe('parseProbeOutput', () => {
  it('归一化 h264+aac 的基本字段', () => {
    const m = h264Meta()
    expect(m.durationSec).toBeCloseTo(624.557267, 6)
    expect(m.sizeBytes).toBe(256901120)
    expect(m.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2')
    expect(m.bitRate).toBe(5192000)
    expect(m.streams).toHaveLength(2)
  })

  it('把 snake_case 字段映射成 camelCase 并转换数字类型', () => {
    const v = h264Meta().streams[0]
    expect(v.codecType).toBe('video')
    expect(v.codecName).toBe('h264')
    expect(v.profile).toBe('High')
    // ffprobe 的 level 是实际值 ×10
    expect(v.level).toBe(40)
    expect(v.width).toBe(1920)
    expect(v.height).toBe(1080)
    expect(v.pixFmt).toBe('yuv420p')
    // 分数形式必须原样保留，才能精确复刻 NTSC 帧率
    expect(v.rFrameRate).toBe('30000/1001')
    // bit_rate 是字符串，要转成 number
    expect(v.bitRate).toBe(5000000)
    expect(v.colorPrimaries).toBe('bt709')
    expect(v.colorTransfer).toBe('bt709')
    expect(v.colorSpace).toBe('bt709')
  })

  it('音频流的 sample_rate 字符串转数字', () => {
    const a = h264Meta().streams[1]
    expect(a.codecType).toBe('audio')
    expect(a.sampleRate).toBe(48000)
    expect(a.channels).toBe(2)
    expect(a.channelLayout).toBe('stereo')
    expect(a.bitRate).toBe(192000)
  })

  it('保留多音轨、字幕轨和 data 轨', () => {
    const m = hevcMeta()
    expect(m.streams).toHaveLength(5)
    expect(m.streams.filter((s) => s.codecType === 'audio')).toHaveLength(2)
    expect(m.streams.filter((s) => s.codecType === 'subtitle')).toHaveLength(1)
    // data 流要被识别出来（切分时用 -dn 丢掉，但元数据里要能看到）
    expect(m.streams.filter((s) => s.codecType === 'data')).toHaveLength(1)
  })

  it('r_frame_rate 为 0/0 时不当作错误', () => {
    const a = h264Meta().streams[1]
    expect(a.rFrameRate).toBe('0/0')
  })

  it('保留语言标签', () => {
    const m = hevcMeta()
    expect(m.streams[1].tags?.language).toBe('eng')
    expect(m.streams[2].tags?.language).toBe('chi')
  })

  it('非 JSON 输入报错', () => {
    expect(() => parseProbeOutput('not json', { path: '/a.mp4', dir: '/', base: 'a', ext: '.mp4' }))
      .toThrow(/无法解析 ffprobe 输出/)
  })

  it('不含视频流时报错', () => {
    const json = JSON.stringify({
      streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3' }],
      format: { duration: '10.0', size: '100' },
    })
    expect(() => parseProbeOutput(json, { path: '/a.mp3', dir: '/', base: 'a', ext: '.mp3' }))
      .toThrow(/不含视频流/)
  })

  it('时长缺失或为 0 时报错', () => {
    const base = { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }] }
    const noDur = JSON.stringify({ ...base, format: { size: '100' } })
    expect(() => parseProbeOutput(noDur, { path: '/a.mp4', dir: '/', base: 'a', ext: '.mp4' }))
      .toThrow(/无法读取视频时长/)

    const zeroDur = JSON.stringify({ ...base, format: { duration: '0', size: '100' } })
    expect(() => parseProbeOutput(zeroDur, { path: '/a.mp4', dir: '/', base: 'a', ext: '.mp4' }))
      .toThrow(/无法读取视频时长/)
  })

  it('未知 codec_type 归到 unknown 而不是崩溃', () => {
    const json = JSON.stringify({
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'weird_new_type', codec_name: 'xyz' },
      ],
      format: { duration: '10.0', size: '100' },
    })
    const m = parseProbeOutput(json, { path: '/a.mp4', dir: '/', base: 'a', ext: '.mp4' })
    expect(m.streams[1].codecType).toBe('unknown')
  })
})

describe('frameRateToNumber', () => {
  it('计算分数帧率', () => {
    expect(frameRateToNumber('30000/1001')).toBeCloseTo(29.97, 2)
    expect(frameRateToNumber('60/1')).toBe(60)
    expect(frameRateToNumber('25/1')).toBe(25)
  })

  it('非法值返回 null', () => {
    expect(frameRateToNumber('0/0')).toBeNull()
    expect(frameRateToNumber(undefined)).toBeNull()
    expect(frameRateToNumber('abc')).toBeNull()
  })
})

describe('describeMeta', () => {
  it('生成 h264 的可读摘要', () => {
    const lines = describeMeta(h264Meta())
    expect(lines[0]).toBe('h264 · High@4.0 · 1920×1080 · yuv420p · 29.97fps')
    expect(lines[1]).toBe('aac · 48kHz · 立体声')
  })

  it('标注额外音轨和字幕轨', () => {
    const lines = describeMeta(hevcMeta())
    expect(lines[0]).toContain('hevc')
    expect(lines[0]).toContain('3840×2160')
    expect(lines[1]).toContain('+1 条音轨')
    expect(lines[2]).toBe('1 条字幕轨')
  })
})

describe('formatBytes', () => {
  it('按量级选单位', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(256901120)).toBe('245 MB')
    expect(formatBytes(735000000)).toBe('701 MB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
  })
})
