import { describe, it, expect } from 'vitest'
import {
  buildProbeCommand,
  buildFrameProbeCommand,
  buildKeyframeProbeCommand,
  buildSeekLandingCommand,
  parseKeyframeOutput,
  parseFirstPacketPts,
  snapToKeyframe,
  snapForwardToKeyframe,
  buildCutCommand,
  buildConcatListContent,
  buildConcatCommand,
  buildJobCommands,
  buildOutputPath,
  checkCompressModeSupport,
  renderCommandLine,
  toPosixPath,
  joinPosix,
} from '../src/shared/commands'
import type { VideoMeta } from '../src/shared/types'
import { DEFAULT_SUFFIX } from '../src/shared/types'
import { h264Meta, hevcMeta, seg, flagValue } from './helpers'

describe('路径处理', () => {
  it('反斜杠统一转正斜杠', () => {
    // concat 列表文件里反斜杠会被当转义符，必须正斜杠
    expect(toPosixPath('D:\\video\\demo.mp4')).toBe('D:/video/demo.mp4')
    expect(toPosixPath('/Users/a/b.mp4')).toBe('/Users/a/b.mp4')
  })

  it('joinPosix 拼接并折叠重复斜杠', () => {
    expect(joinPosix('/tmp/x', 'seg_000.mp4')).toBe('/tmp/x/seg_000.mp4')
    expect(joinPosix('/tmp/x/', '/seg_000.mp4')).toBe('/tmp/x/seg_000.mp4')
    expect(joinPosix('C:\\tmp', 'list.txt')).toBe('C:/tmp/list.txt')
  })
})

describe('buildProbeCommand', () => {
  it('输出 JSON 格式的完整元数据', () => {
    const c = buildProbeCommand('/videos/demo.mp4')
    expect(c.bin).toBe('ffprobe')
    expect(c.argv).toEqual([
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '/videos/demo.mp4',
    ])
  })
})

describe('关键帧探测', () => {
  it('用 read_intervals 限定窗口而非全文件扫描', () => {
    const c = buildKeyframeProbeCommand('/videos/demo.mp4', 13)
    // 窗口从 13-6=7 开始，长 12 秒
    expect(flagValue(c.argv, '-read_intervals')).toBe('7%+12')
    // 读 packet 不读 frame：不需要解码，快一个量级
    expect(c.argv).toContain('-show_packets')
    expect(c.argv).not.toContain('-show_frames')
    expect(flagValue(c.argv, '-select_streams')).toBe('v:0')
    expect(flagValue(c.argv, '-show_entries')).toBe('packet=pts_time,flags')
  })

  it('目标时间接近 0 时窗口起点不为负', () => {
    const c = buildKeyframeProbeCommand('/videos/demo.mp4', 2)
    expect(flagValue(c.argv, '-read_intervals')).toBe('0%+12')
  })

  it('窗口参数可调（用于扩大窗口重试）', () => {
    const c = buildKeyframeProbeCommand('/videos/demo.mp4', 100, 30, 60)
    expect(flagValue(c.argv, '-read_intervals')).toBe('70%+60')
  })
})

describe('DEFAULT_SUFFIX（模式默认后缀）', () => {
  it('流复制与压缩的默认后缀不同', () => {
    expect(DEFAULT_SUFFIX.copy).toBe('_cut')
    expect(DEFAULT_SUFFIX.compress).toBe('_cut_compressed')
    expect(DEFAULT_SUFFIX.copy).not.toBe(DEFAULT_SUFFIX.compress)
  })
})

describe('buildFrameProbeCommand（终点帧边界探测）', () => {
  it('用绝对终点而不是相对时长，保证窗口覆盖目标时间', () => {
    const c = buildFrameProbeCommand('/videos/demo.mp4', 13)
    // 起点向前 2s、终点向后 6s，都是绝对时间；`%` 只吸附起点到关键帧，终点不受影响
    expect(flagValue(c.argv, '-read_intervals')).toBe('11%19')
    expect(flagValue(c.argv, '-select_streams')).toBe('v:0')
    expect(flagValue(c.argv, '-show_entries')).toBe('packet=pts_time')
    // 读 packet 不读 frame：不需要解码
    expect(c.argv).toContain('-show_packets')
    expect(c.argv).not.toContain('-show_frames')
  })

  it('目标接近 0 时窗口起点不为负', () => {
    const c = buildFrameProbeCommand('/videos/demo.mp4', 1)
    expect(flagValue(c.argv, '-read_intervals')).toBe('0%7')
  })

  it('窗口参数可调（回看与终点余量）', () => {
    const c = buildFrameProbeCommand('/videos/demo.mp4', 100, 30, 5)
    expect(flagValue(c.argv, '-read_intervals')).toBe('70%105')
  })
})

describe('parseKeyframeOutput', () => {
  it('只取带 K 标志的包', () => {
    const out = [
      '7.500000,K__',
      '7.533333,__',
      '8.000000,__',
      '9.500000,K__',
      '10.000000,__',
    ].join('\n')
    expect(parseKeyframeOutput(out)).toEqual([7.5, 9.5])
  })

  it('容忍空行和结尾换行', () => {
    expect(parseKeyframeOutput('\n7.500000,K__\n\n9.500000,K__\n')).toEqual([7.5, 9.5])
  })

  it('结果升序', () => {
    expect(parseKeyframeOutput('9.5,K__\n7.5,K__')).toEqual([7.5, 9.5])
  })

  it('无关键帧时返回空数组', () => {
    expect(parseKeyframeOutput('7.5,__\n8.0,__')).toEqual([])
    expect(parseKeyframeOutput('')).toEqual([])
  })
})

describe('snapToKeyframe（向前吸附）', () => {
  const kf = [0, 2, 4, 6, 8, 10]

  it('取 <= target 的最近关键帧', () => {
    expect(snapToKeyframe(kf, 5)).toBe(4)
    expect(snapToKeyframe(kf, 7.9)).toBe(6)
    expect(snapToKeyframe(kf, 10)).toBe(10)
  })

  it('正好落在关键帧上时不移动', () => {
    expect(snapToKeyframe(kf, 4)).toBe(4)
    expect(snapToKeyframe(kf, 0)).toBe(0)
  })

  it('容忍浮点误差', () => {
    // 4.0000000001 应吸附到 4 而不是 2
    expect(snapToKeyframe(kf, 4 + 1e-9)).toBe(4)
  })

  it('没有更早的关键帧时返回 null（调用方应扩大窗口）', () => {
    expect(snapToKeyframe([6, 8], 5)).toBeNull()
    expect(snapToKeyframe([], 5)).toBeNull()
  })
})

describe('snapForwardToKeyframe（向后扩，用于终点）', () => {
  const kf = [0, 2, 4, 6, 8, 10]

  it('取 >= target 的最近关键帧', () => {
    expect(snapForwardToKeyframe(kf, 5)).toBe(6)
    expect(snapForwardToKeyframe(kf, 2.1)).toBe(4)
    expect(snapForwardToKeyframe(kf, 0.5)).toBe(2)
  })

  it('正好落在关键帧上时不移动', () => {
    expect(snapForwardToKeyframe(kf, 4)).toBe(4)
    expect(snapForwardToKeyframe(kf, 0)).toBe(0)
  })

  it('容忍浮点误差', () => {
    // 3.9999999 应取 4 本身，而不是跳到 6
    expect(snapForwardToKeyframe(kf, 4 - 1e-9)).toBe(4)
  })

  it('没有更晚的关键帧时返回 null（调用方回退到视频总时长）', () => {
    expect(snapForwardToKeyframe(kf, 11)).toBeNull()
    expect(snapForwardToKeyframe([], 5)).toBeNull()
  })

  it('方向与 snapToKeyframe 相反：同一目标一前一后', () => {
    // 两端都向外扩，宁可多切不要缺
    expect(snapToKeyframe(kf, 5)).toBe(4)
    expect(snapForwardToKeyframe(kf, 5)).toBe(6)
  })
})

describe('buildSeekLandingCommand', () => {
  it('用 -copyts 保留原始时间戳，抽一个包不解码', () => {
    const c = buildSeekLandingCommand('/videos/demo.mkv', 13)
    expect(c.bin).toBe('ffmpeg')
    // -copyts 是关键：不保留原始时间戳就读不出实际落点
    expect(c.argv).toContain('-copyts')
    expect(flagValue(c.argv, '-frames:v')).toBe('1')
    expect(flagValue(c.argv, '-c')).toBe('copy')
    expect(flagValue(c.argv, '-map')).toBe('0:v:0')
  })

  it('-ss 在 -i 之前，与真实切分命令一致', () => {
    // 落点探测必须复现切分时的 seek 行为，否则测出来的落点没有意义
    const c = buildSeekLandingCommand('/videos/demo.mkv', 13)
    expect(c.argv.indexOf('-ss')).toBeLessThan(c.argv.indexOf('-i'))
    expect(flagValue(c.argv, '-ss')).toBe('13.000')
  })

  it('用 nut 容器：几乎接受任何 codec，不像 mp4 会因兼容性失败', () => {
    const c = buildSeekLandingCommand('/videos/demo.mkv', 13)
    expect(flagValue(c.argv, '-f')).toBe('nut')
  })
})

describe('parseFirstPacketPts', () => {
  it('取第一行的 pts', () => {
    expect(parseFirstPacketPts('10.000000\n10.040000\n')).toBe(10)
    expect(parseFirstPacketPts('0.000000\n')).toBe(0)
  })

  it('容忍空行', () => {
    expect(parseFirstPacketPts('\n\n12.480000\n')).toBeCloseTo(12.48, 6)
  })

  it('无有效数据返回 null', () => {
    expect(parseFirstPacketPts('')).toBeNull()
    expect(parseFirstPacketPts('N/A\n')).toBeNull()
  })
})

describe('buildCutCommand — 流复制模式', () => {
  const meta = h264Meta()
  // 起点向前吸附到 12.48，终点向后扩到 92.0
  const c = buildCutCommand(
    meta,
    seg(13, 90, 12.48, 92),
    'copy',
    'svtav1',
    '/tmp/x/seg_000.mp4',
    '切分第 1/2 段'
  )

  it('-ss 必须在 -i 之前', () => {
    // 放在 -i 之后配合 -c copy 会得到开头花屏，这是最经典的坑
    const ssIdx = c.argv.indexOf('-ss')
    const iIdx = c.argv.indexOf('-i')
    expect(ssIdx).toBeGreaterThanOrEqual(0)
    expect(ssIdx).toBeLessThan(iIdx)
  })

  it('-ss 传用户输入的原始起点，不是吸附后的值', () => {
    // 实测语义：-ss S -t D 产出 [落点(S), S+D]，ffmpeg 自己会把起点向前落到关键帧。
    // 若传已吸附的值，matroska 上会被再向前落一格（seek 在关键帧上不幂等），
    // 等于吸附两次 —— 实测切早了 2 秒，且 UI 显示的切点与实际内容不符。
    expect(flagValue(c.argv, '-ss')).toBe('13.000')
  })

  it('-t 相对请求的起点算，终点用向后留过余量的值', () => {
    // -to 的基准在不同 ffmpeg 版本上有歧义，-t 永远明确
    expect(c.argv).not.toContain('-to')
    // 92 - 13 = 79（相对 rawStart，不是相对落点 12.48）
    expect(flagValue(c.argv, '-t')).toBe('79.000')
  })

  it('expectedDurationSec 按落点算，反映实际产出时长', () => {
    // 进度加权要用实际时长：92 - 12.48 = 79.52
    expect(c.expectedDurationSec).toBeCloseTo(79.52, 6)
  })

  it('两端都向外：实际时长 ≥ 用户请求的时长', () => {
    const requested = 90 - 13
    expect(c.expectedDurationSec).toBeGreaterThan(requested)
  })

  it('流复制 + 修正负时间戳', () => {
    expect(flagValue(c.argv, '-c')).toBe('copy')
    expect(flagValue(c.argv, '-avoid_negative_ts')).toBe('make_zero')
  })

  it('保留所有音视频字幕轨、丢掉 data 轨、跳过未知流', () => {
    expect(flagValue(c.argv, '-map')).toBe('0')
    expect(c.argv).toContain('-dn')
    expect(c.argv).toContain('-ignore_unknown')
  })

  it('开启进度输出并关闭 stats', () => {
    expect(flagValue(c.argv, '-progress')).toBe('pipe:1')
    expect(c.argv).toContain('-nostats')
  })

  it('非交互、覆盖已存在的临时文件', () => {
    expect(c.argv).toContain('-nostdin')
    expect(c.argv).toContain('-y')
  })

  it('输出路径在最后', () => {
    expect(c.argv[c.argv.length - 1]).toBe('/tmp/x/seg_000.mp4')
  })

  it('没有吸附结果时终点用原值', () => {
    const c2 = buildCutCommand(meta, seg(13, 90), 'copy', 'svtav1', '/tmp/x/seg_000.mp4', 'x')
    expect(flagValue(c2.argv, '-ss')).toBe('13.000')
    expect(flagValue(c2.argv, '-t')).toBe('77.000')
  })

  it('只有起点吸附时终点用原值，-ss 仍是原始起点', () => {
    const c3 = buildCutCommand(meta, seg(13, 90, 12), 'copy', 'svtav1', '/tmp/x/s.mp4', 'x')
    expect(flagValue(c3.argv, '-ss')).toBe('13.000')
    expect(flagValue(c3.argv, '-t')).toBe('77.000')
    // 实际产出从落点 12 开始，所以时长是 78
    expect(c3.expectedDurationSec).toBeCloseTo(78, 6)
  })

  it('完整 argv 快照', () => {
    expect(c.argv).toEqual([
      '-hide_banner', '-nostdin', '-y',
      '-progress', 'pipe:1', '-nostats',
      '-ss', '13.000',
      '-i', '/Users/zhuhuanqi/videos/demo.mp4',
      '-t', '79.000',
      '-map', '0', '-dn', '-ignore_unknown',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '/tmp/x/seg_000.mp4',
    ])
  })
})

describe('buildCutCommand — 压缩模式', () => {
  const meta = h264Meta()
  // 压缩模式忽略吸附结果，直接用用户输入的时间，与精确模式一致
  const c = buildCutCommand(meta, seg(13, 90, 12.48, 92), 'compress', 'svtav1', '/tmp/x/seg_000.mp4', 'x')

  it('用用户输入的时间，两端都不吸附', () => {
    expect(flagValue(c.argv, '-ss')).toBe('13.000')
    expect(flagValue(c.argv, '-t')).toBe('77.000')
  })

  it('不使用 -c copy', () => {
    expect(c.argv).not.toContain('-avoid_negative_ts')
    expect(c.argv.indexOf('-c')).toBe(-1)
  })

  it('视频用 libsvtav1 + VBR 目标码率（源码率×0.90）+ preset，不再用 CRF', () => {
    // h264 fixture 的视频流码率 5,000,000 → 目标 = 5000000 × 0.90 = 4,500,000
    expect(flagValue(c.argv, '-c:v')).toBe('libsvtav1')
    expect(flagValue(c.argv, '-b:v')).toBe('4500000')
    expect(flagValue(c.argv, '-preset')).toBe('8')
    expect(flagValue(c.argv, '-pix_fmt')).toBe('yuv420p10le')
    expect(c.argv).not.toContain('-crf')
  })

  it('音频直接复制，不重编码', () => {
    expect(flagValue(c.argv, '-c:a')).toBe('copy')
    expect(c.argv).not.toContain('-b:a')
  })

  it('不复刻 profile/level（只锚定码率上限，不复刻具体编码参数）', () => {
    expect(c.argv).not.toContain('-profile:v')
    expect(c.argv).not.toContain('-level')
  })

  it('源码率探测不到时回退 CRF 质量档', () => {
    const noBr = { ...meta, streams: meta.streams.map((s) => ({ ...s, bitRate: undefined })) }
    const c2 = buildCutCommand(noBr, seg(10, 20), 'compress', 'svtav1', '/tmp/x/seg_000.mp4', 'x')
    expect(flagValue(c2.argv, '-crf')).toBe('28')
    expect(c2.argv).not.toContain('-b:v')
  })

  it('无字幕轨时不加 -c:s', () => {
    expect(c.argv).not.toContain('-c:s')
  })

  it('有字幕轨时字幕直接复制', () => {
    const c2 = buildCutCommand(hevcMeta(), seg(10, 20), 'compress', 'svtav1', '/tmp/x/seg_000.mkv', 'x')
    expect(flagValue(c2.argv, '-c:s')).toBe('copy')
  })

  it('与视频原编码无关，hevc 源同样走 libsvtav1', () => {
    const c2 = buildCutCommand(hevcMeta(), seg(10, 20), 'compress', 'svtav1', '/tmp/x/seg_000.mkv', 'x')
    expect(flagValue(c2.argv, '-c:v')).toBe('libsvtav1')
  })
})

describe('buildCutCommand — 压缩模式硬件编码器（amf）', () => {
  const meta = h264Meta()

  it('用 av1_amf + vbr_peak + 目标码率（源码率×0.90）', () => {
    const c = buildCutCommand(meta, seg(13, 90), 'compress', 'amf', '/tmp/x/seg_000.mp4', 'x')
    expect(flagValue(c.argv, '-c:v')).toBe('av1_amf')
    expect(flagValue(c.argv, '-rc')).toBe('vbr_peak')
    expect(flagValue(c.argv, '-b:v')).toBe('4500000')
    expect(flagValue(c.argv, '-quality')).toBe('quality')
    expect(flagValue(c.argv, '-pix_fmt')).toBe('yuv420p')
  })

  it('源码率探测不到时回退 CQP 质量档', () => {
    const noBr = { ...meta, streams: meta.streams.map((s) => ({ ...s, bitRate: undefined })) }
    const c = buildCutCommand(noBr, seg(13, 90), 'compress', 'amf', '/tmp/x/seg_000.mp4', 'x')
    expect(flagValue(c.argv, '-rc')).toBe('cqp')
    expect(flagValue(c.argv, '-min_qp_i')).toBe('26')
    expect(flagValue(c.argv, '-max_qp_i')).toBe('26')
    expect(flagValue(c.argv, '-min_qp_p')).toBe('26')
    expect(flagValue(c.argv, '-max_qp_p')).toBe('26')
    expect(c.argv).not.toContain('-b:v')
  })

  it('不出现软件编码器的参数', () => {
    const c = buildCutCommand(meta, seg(13, 90), 'compress', 'amf', '/tmp/x/seg_000.mp4', 'x')
    expect(c.argv).not.toContain('-crf')
    expect(c.argv).not.toContain('-preset')
    expect(flagValue(c.argv, '-c:a')).toBe('copy')
  })
})

describe('checkCompressModeSupport', () => {
  it('有视频流即支持，不要求特定编码', () => {
    expect(checkCompressModeSupport(h264Meta())).toEqual({ ok: true })
    expect(checkCompressModeSupport(hevcMeta())).toEqual({ ok: true })
  })

  it('没有视频流时不支持', () => {
    const meta: VideoMeta = { ...h264Meta(), streams: [] }
    const r = checkCompressModeSupport(meta)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('视频流')
  })

  it('未知视频编码（如 ProRes）仍然支持 —— 不依赖编码映射表', () => {
    const meta: VideoMeta = {
      ...h264Meta(),
      streams: [{ index: 0, codecType: 'video', codecName: 'prores' }],
    }
    expect(checkCompressModeSupport(meta)).toEqual({ ok: true })
  })
})

describe('buildConcatListContent', () => {
  it('每行一个 file 指令，用单引号包裹', () => {
    expect(buildConcatListContent(['/tmp/x/seg_000.mp4', '/tmp/x/seg_001.mp4']))
      .toBe("file '/tmp/x/seg_000.mp4'\nfile '/tmp/x/seg_001.mp4'\n")
  })

  it('Windows 路径转正斜杠', () => {
    expect(buildConcatListContent(['C:\\tmp\\seg_000.mp4']))
      .toBe("file 'C:/tmp/seg_000.mp4'\n")
  })

  it("路径中的单引号转义为 '\\''", () => {
    expect(buildConcatListContent(["/tmp/it's/seg_000.mp4"]))
      .toBe("file '/tmp/it'\\''s/seg_000.mp4'\n")
  })

  it('结尾有换行', () => {
    expect(buildConcatListContent(['/a.mp4']).endsWith('\n')).toBe(true)
  })
})

describe('buildConcatCommand', () => {
  it('用 concat demuxer 且 -safe 0', () => {
    const c = buildConcatCommand('/tmp/x/list.txt', '/tmp/x/output.mp4', 122)
    // demuxer 是容器层拼接可以 -c copy；filter 必须重编码，与需求矛盾
    expect(flagValue(c.argv, '-f')).toBe('concat')
    expect(flagValue(c.argv, '-safe')).toBe('0')
    expect(flagValue(c.argv, '-c')).toBe('copy')
    expect(flagValue(c.argv, '-map')).toBe('0')
  })

  it('mp4 系容器加 +faststart', () => {
    for (const ext of ['.mp4', '.m4v', '.mov']) {
      const c = buildConcatCommand('/tmp/x/list.txt', `/tmp/x/output${ext}`, 122)
      expect(flagValue(c.argv, '-movflags')).toBe('+faststart')
    }
  })

  it('mkv 不加 +faststart（会报错）', () => {
    const c = buildConcatCommand('/tmp/x/list.txt', '/tmp/x/output.mkv', 122)
    expect(c.argv).not.toContain('-movflags')
  })

  it('扩展名大小写不敏感', () => {
    const c = buildConcatCommand('/tmp/x/list.txt', '/tmp/x/output.MP4', 122)
    expect(flagValue(c.argv, '-movflags')).toBe('+faststart')
  })

  it('记录总时长供进度用', () => {
    const c = buildConcatCommand('/tmp/x/list.txt', '/tmp/x/output.mp4', 122)
    expect(c.expectedDurationSec).toBe(122)
  })
})

describe('buildJobCommands', () => {
  const meta = h264Meta()

  it('多段：N 条切分 + 1 条拼接', () => {
    const segs = [seg(13, 90, 12.48), seg(120, 165, 120), seg(300, 330, 298)]
    const r = buildJobCommands(meta, segs, 'copy', 'svtav1', '/Users/zhuhuanqi/videos/demo_cut.mp4', '/tmp/vc')

    expect(r.commands).toHaveLength(4)
    expect(r.commands[0].label).toBe('切分第 1/3 段')
    expect(r.commands[2].label).toBe('切分第 3/3 段')
    expect(r.commands[3].label).toBe('拼接所有段落')
    expect(r.needsConcat).toBe(true)
  })

  it('临时段落文件用源文件的扩展名（保证容器一致）', () => {
    const segs = [seg(13, 90), seg(120, 165)]
    const r = buildJobCommands(meta, segs, 'copy', 'svtav1', '/videos/demo_cut.mp4', '/tmp/vc')
    expect(r.segmentPaths).toEqual(['/tmp/vc/seg_000.mp4', '/tmp/vc/seg_001.mp4'])
  })

  it('mkv 源的临时文件也是 mkv', () => {
    const r = buildJobCommands(hevcMeta(), [seg(10, 20), seg(30, 40)], 'copy', 'svtav1', '/videos/x_cut.mkv', '/tmp/vc')
    expect(r.segmentPaths).toEqual(['/tmp/vc/seg_000.mkv', '/tmp/vc/seg_001.mkv'])
  })

  it('总时长按吸附后的两端算', () => {
    const segs = [seg(13, 90, 12.48, 92), seg(120, 165, 120, 166)]
    const r = buildJobCommands(meta, segs, 'copy', 'svtav1', '/videos/demo_cut.mp4', '/tmp/vc')
    // (92-12.48) + (166-120) = 125.52
    expect(r.totalDurationSec).toBeCloseTo(125.52, 6)
  })

  it('最终输出先落在临时目录（避免留下半成品）', () => {
    const segs = [seg(13, 90), seg(120, 165)]
    const r = buildJobCommands(meta, segs, 'copy', 'svtav1', '/videos/demo_cut.mp4', '/tmp/vc')
    expect(r.stagedOutput).toBe('/tmp/vc/output.mp4')
  })

  it('只有一段时跳过 concat，直接重命名首段', () => {
    const r = buildJobCommands(meta, [seg(13, 90, 12.48)], 'copy', 'svtav1', '/videos/demo_cut.mp4', '/tmp/vc')
    expect(r.commands).toHaveLength(1)
    expect(r.needsConcat).toBe(false)
    expect(r.stagedOutput).toBe('/tmp/vc/seg_000.mp4')
  })

  it('concat 列表内容与段落路径一致', () => {
    const segs = [seg(13, 90), seg(120, 165)]
    const r = buildJobCommands(meta, segs, 'copy', 'svtav1', '/videos/demo_cut.mp4', '/tmp/vc')
    expect(r.listPath).toBe('/tmp/vc/list.txt')
    expect(r.listContent).toBe("file '/tmp/vc/seg_000.mp4'\nfile '/tmp/vc/seg_001.mp4'\n")
  })

  it('段落顺序即拼接顺序，不自动按时间排序', () => {
    // 用户可能故意打乱顺序拼接
    const segs = [seg(300, 330), seg(13, 90)]
    const r = buildJobCommands(meta, segs, 'copy', 'svtav1', '/videos/demo_cut.mp4', '/tmp/vc')
    expect(flagValue(r.commands[0].argv, '-ss')).toBe('300.000')
    expect(flagValue(r.commands[1].argv, '-ss')).toBe('13.000')
  })
})

describe('buildOutputPath', () => {
  it('原目录 + 原文件名 + 后缀 + 原扩展名', () => {
    expect(buildOutputPath(h264Meta(), '_cut')).toBe('/Users/zhuhuanqi/videos/demo_cut.mp4')
  })

  it('保留含空格和单引号的文件名', () => {
    expect(buildOutputPath(hevcMeta(), '_cut')).toBe("/Users/zhuhuanqi/videos/4k clip's_cut.mkv")
  })

  it('空后缀会覆盖原文件（调用方需拦截）', () => {
    expect(buildOutputPath(h264Meta(), '')).toBe('/Users/zhuhuanqi/videos/demo.mp4')
  })
})

describe('renderCommandLine', () => {
  it('含空格的参数加引号', () => {
    const c = buildCutCommand(hevcMeta(), seg(10, 20), 'copy', 'svtav1', '/tmp/vc/seg_000.mkv', 'x')
    const line = renderCommandLine(c)
    expect(line.startsWith('ffmpeg ')).toBe(true)
    expect(line).toContain('"/Users/zhuhuanqi/videos/4k clip\'s.mkv"')
  })

  it('无特殊字符的参数不加引号', () => {
    const line = renderCommandLine(buildProbeCommand('/videos/demo.mp4'))
    expect(line).toBe('ffprobe -v error -print_format json -show_format -show_streams /videos/demo.mp4')
  })
})
