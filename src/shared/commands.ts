/**
 * ffmpeg / ffprobe 命令构造。
 *
 * 全部是纯函数：输入元数据 + 段落 + 选项，输出 CommandSpec[]。
 * 这样做的两个好处：
 *   1. 脱离 Electron 和 ffmpeg 就能单测（用固化的 ffprobe fixture）
 *   2. Dry-run 面板和真实执行走同一条代码路径，不会显示与实际不一致
 *
 * 路径统一用正斜杠：ffmpeg 在 Windows 上同样接受正斜杠，而 concat demuxer
 * 的列表文件里反斜杠会被当作转义符，必须是正斜杠。统一了就不用分情况处理。
 */

import type { CommandSpec, CompressEncoder, CutMode, Segment, StreamInfo, VideoMeta } from './types'
import { toFFmpegTime } from './time'

/** 需要 +faststart 的容器扩展名（把 moov box 移到文件头，便于快速起播） */
const FASTSTART_EXTS = new Set(['.mp4', '.m4v', '.mov', '.m4a'])

/** 压缩模式的 AV1 编码参数：CRF 越低画质越好体积越大，28 是压体积优先的中间值 */
const COMPRESS_CRF = 28
/**
 * SVT-AV1 的 preset：0-13，越小越慢越省体积。
 * 6 是速度与体积的折中，但对 1 小时以上的长视频太慢（1080p 约 20 分钟）；
 * 8 提速约一倍、体积只大几个百分点，是长视频性价比最高的档位。
 */
const COMPRESS_PRESET = 8

/** 用正斜杠拼接路径片段 */
export function joinPosix(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\\/g, '/') : p.replace(/\\/g, '/').replace(/^\/+/, '')))
    .join('/')
    .replace(/\/{2,}/g, '/')
}

/** 转成 concat 列表文件 / ffmpeg 参数可用的正斜杠形式 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** ffprobe 元数据探测命令 */
export function buildProbeCommand(inputPath: string): CommandSpec {
  return {
    label: '读取视频元数据',
    bin: 'ffprobe',
    argv: [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      toPosixPath(inputPath),
    ],
  }
}

/**
 * 探测 ffmpeg `-ss` 的**真实落点**。
 *
 * 为什么不能只靠读 packet 的关键帧列表推算：在 matroska + B 帧的组合下，
 * ffmpeg 的输入 seek 会落在比「≤目标时间的最近关键帧」更早的位置（实测
 * mkv 上 `-ss 12` 落到 10.0s，而 12.0s 明明就是关键帧）。mkv 的 seek 以
 * cluster 为单位，cluster 边界由输入文件决定，我们无法从关键帧列表推出来。
 *
 * 所以直接问 ffmpeg 本人：用同样的 `-ss` 抽第一个包、`-copyts` 保留原始
 * 时间戳、`-c copy` 不解码，然后读这个包的 pts —— 那就是实际落点。
 * 实测耗时约 60ms，可以接受。
 *
 * 用 `-f nut` 输出到 stdout：nut 容器几乎接受任何 codec，不像 mp4 会因为
 * codec 不兼容而失败；写到 stdout 避免产生临时文件。
 */
export function buildSeekLandingCommand(inputPath: string, targetSec: number): CommandSpec {
  return {
    label: `探测 ${toFFmpegTime(targetSec)}s 的实际落点`,
    bin: 'ffmpeg',
    argv: [
      '-hide_banner',
      '-nostdin',
      '-v', 'error',
      '-copyts',
      '-ss', toFFmpegTime(targetSec),
      '-i', toPosixPath(inputPath),
      '-map', '0:v:0',
      '-c', 'copy',
      '-frames:v', '1',
      '-f', 'nut',
      '-',
    ],
  }
}

/**
 * 帧边界探测命令：列出目标时间附近的所有帧（不只关键帧）的 pts。
 *
 * 用于**终点**吸附：终点不受关键帧限制（`-t` 控制输出时长，解码器能停在任意
 * 帧），但要吸附到真实的帧边界才能幂等 —— 盲目「加一帧余量」的做法每次都会
 * 再加一帧，把终点越推越后。
 *
 * 仍然读 packet 不读 frame：不需要解码，快一个量级。
 */
export function buildFrameProbeCommand(
  inputPath: string,
  aroundSec: number,
  backSec = 2,
  afterSec = 6
): CommandSpec {
  // 终点用绝对时间（`from%to` 形式），不能用 `from%+len`（相对时长）。
  // ffprobe 的 read_intervals 会把窗口起点吸附到 from 前最近的**关键帧**，再按
  // `+len` 往后数 len 秒 —— 若关键帧离 from 很远（GOP 可达 8s+），窗口就够不到
  // aroundSec。终点吸附因此漏检并回退到整片时长，导致整段被切到视频结束。
  // 用绝对终点后窗口必然是 `[关键帧(from), to]`，而关键帧(from) ≤ from <
  // aroundSec < to，保证覆盖目标时间，与 GOP 大小无关。
  const from = Math.max(0, aroundSec - backSec)
  const to = aroundSec + afterSec
  return {
    label: `探测 ${toFFmpegTime(aroundSec)}s 附近的帧边界`,
    bin: 'ffprobe',
    argv: [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_packets',
      '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0',
      '-read_intervals', `${from}%${to}`,
      toPosixPath(inputPath),
    ],
  }
}

/** 解析帧边界探测的输出，返回升序的 pts 列表 */
export function parseFrameTimes(stdout: string): number[] {
  const result: number[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const pts = Number(t.split(',')[0])
    if (Number.isFinite(pts)) result.push(pts)
  }
  return result.sort((a, b) => a - b)
}

/**
 * 关键帧探测命令（读 packet 列表）。
 *
 * 只探目标时间附近的窗口而不是全文件扫描 —— 长视频全扫要几十秒。
 * 读 packet 而不是 frame：packet 不需要解码，快一个量级，而 packet 的
 * K 标志已经足够判断关键帧。
 *
 * 现在主要用于**终点向后扩**（找 ≥ 终点的下一个关键帧）和作为落点探测
 * 失败时的回退。起点的落点由 buildSeekLandingCommand 实测得出。
 *
 * @param aroundSec 目标时间
 * @param backSec 向前回看的秒数（窗口起点 = max(0, aroundSec - backSec)）
 * @param windowSec 窗口长度
 */
export function buildKeyframeProbeCommand(
  inputPath: string,
  aroundSec: number,
  backSec = 6,
  windowSec = 12
): CommandSpec {
  const from = Math.max(0, aroundSec - backSec)
  return {
    label: `探测 ${toFFmpegTime(aroundSec)}s 附近的关键帧`,
    bin: 'ffprobe',
    argv: [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_packets',
      '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=p=0',
      '-read_intervals', `${from}%+${windowSec}`,
      toPosixPath(inputPath),
    ],
  }
}

/**
 * 从 buildSeekLandingCommand 的输出里解析出实际落点。
 *
 * 输出是二进制的 nut 流，不能直接解析 —— 由调用方（main 层）把它写到临时
 * 文件再 ffprobe。这里只提供解析 ffprobe 结果的部分。
 */
export function parseFirstPacketPts(stdout: string): number | null {
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const pts = Number(t.split(',')[0])
    if (Number.isFinite(pts)) return pts
  }
  return null
}

/**
 * 解析 buildKeyframeProbeCommand 的 stdout，返回窗口内所有关键帧时间点（升序）。
 *
 * 输出形如 `7.500000,K__`，flags 含 K 即关键帧。
 */
export function parseKeyframeOutput(stdout: string): number[] {
  const result: number[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const [ptsRaw, flags] = t.split(',')
    if (!flags || !flags.includes('K')) continue
    const pts = Number(ptsRaw)
    if (Number.isFinite(pts)) result.push(pts)
  }
  return result.sort((a, b) => a - b)
}

/**
 * 从关键帧列表里挑出 <= target 的最近一个（向前吸附）。
 *
 * 现在只作为落点实测失败时的回退 —— 实际落点由 buildSeekLandingCommand 测得，
 * 因为在 mkv + B 帧上 ffmpeg 的 seek 会落得比最近关键帧更早。
 *
 * @returns 吸附后的时间；列表中没有 <= target 的关键帧时返回 null（调用方应扩大窗口重试）
 */
export function snapToKeyframe(keyframes: number[], target: number): number | null {
  let best: number | null = null
  for (const k of keyframes) {
    if (k <= target + 1e-6) best = k
    else break
  }
  return best
}

/**
 * 从时间点列表里挑出 >= target 的最近一个（向后吸附）。
 *
 * 用于终点：宁可多切几帧进来，也不要缺内容。传关键帧列表则吸附到关键帧，
 * 传全部帧的 pts 列表则吸附到帧边界 —— 终点用后者，因为 `-t` 控制的是输出
 * 时长，解码器能停在任意帧，不受关键帧限制。
 *
 * @returns 向后的最近时间点；列表里没有更晚的则返回 null
 *          （通常意味着 target 之后就是片尾，调用方应回退到视频总时长）
 */
export function snapForwardToKeyframe(times: number[], target: number): number | null {
  for (const t of times) {
    if (t >= target - 1e-6) return t
  }
  return null
}

/** 取第一条指定类型的流 */
function firstStream(meta: VideoMeta, type: StreamInfo['codecType']): StreamInfo | undefined {
  return meta.streams.find((s) => s.codecType === type)
}

/**
 * 压缩模式是否可用。不可用时返回原因，用于在 UI 上禁用开关并说明。
 *
 * 只要求有视频流即可 —— 压缩模式统一用 libsvtav1 重编码视频，不依赖原视频的
 * codec；音频轨直接 copy，不重编码也就没有编码器兼容性问题。
 */
export function checkCompressModeSupport(meta: VideoMeta): { ok: boolean; reason?: string } {
  const v = firstStream(meta, 'video')
  if (!v) return { ok: false, reason: '未找到视频流' }
  return { ok: true }
}

/** 取扩展名（小写，含点） */
function extOf(p: string): string {
  const m = /\.[^./\\]+$/.exec(p)
  return m ? m[0].toLowerCase() : ''
}

/**
 * 构造单段切分命令。
 *
 * 流复制模式的几个关键决策（都是踩过的坑）：
 *
 * - `-ss` 放在 `-i` **之前**（input seeking）。配合 `-c copy` 这是唯一正确的位置：
 *   ffmpeg 直接跳到该位置开始读，首帧时间戳归零。若放在 `-i` 之后（output seeking），
 *   `-c copy` 下 ffmpeg 会从头读并丢弃前面的包，但丢不掉非关键帧对前序帧的依赖，
 *   结果是开头一段花屏/静止画面 —— 这是 `-c copy` 切视频得到黑屏开头的根因。
 *
 * - `-ss` 传**用户输入的原始起点**，而不是吸附后的值。这一点很反直觉，但实测
 *   出来的 `-ss S -t D` 语义是：产出内容 = `[落点(S), S+D]` —— 也就是 ffmpeg
 *   自己会把起点向前落到关键帧，而 `-t` 是相对**请求的 S** 计算的。
 *   如果把已经吸附过的值再传给 `-ss`，在 matroska 上会被再向前落一格（seek 在
 *   关键帧上不幂等），等于吸附两次，实测切早了 2 秒。顺着 ffmpeg 的行为走反而
 *   更简单、也天然满足「起点向前、宁可多带」。
 *
 * - 用 `-t <时长>` 而不是 `-to`。`-ss` 在 `-i` 前时，`-to` 的基准（相对原片还是
 *   相对 seek 点）在不同 ffmpeg 版本上有过变化，`-t` 永远无歧义。
 *
 * - `-avoid_negative_ts make_zero`：input seek 后音视频首包时间戳可能为负，
 *   MP4 容器写负时间戳会导致开头卡顿或 A/V 错位，这个参数把它平移到 0。
 *
 * - `-map 0 -dn -ignore_unknown`：保留所有视频/音频/字幕轨（多音轨、内封字幕
 *   都不丢，符合"仅切分"的语义）；`-dn` 丢掉 data 流（如 QuickTime 的 tmcd
 *   时间码轨），这类流 concat 时常报错且无保留价值；`-ignore_unknown` 让未知
 *   类型的流被跳过而不是让整条命令失败。
 *
 * 吸附方向：起点由 ffmpeg 自动向前落到关键帧，终点向后留一点余量。两端都向外，
 * 宁可多带几帧也不丢内容。
 */
export function buildCutCommand(
  meta: VideoMeta,
  seg: Segment,
  mode: CutMode,
  encoder: CompressEncoder,
  outPath: string,
  label: string
): CommandSpec {
  const isCopy = mode === 'copy'
  const rawStart = seg.startSec as number
  // 终点向后留余量（由主进程实测回填）；压缩模式重编码，可以切在任意帧，用原值
  const end = isCopy && seg.snappedEndSec !== undefined
    ? seg.snappedEndSec
    : (seg.endSec as number)

  // -t 相对请求的起点算，所以用 rawStart 而不是落点
  const requestedDuration = end - rawStart
  // 实际产出的时长要按落点算，供进度加权用
  const actualStart = isCopy && seg.snappedStartSec !== undefined ? seg.snappedStartSec : rawStart
  const actualDuration = end - actualStart

  const argv: string[] = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-progress', 'pipe:1',
    '-nostats',
    '-ss', toFFmpegTime(rawStart),
    '-i', toPosixPath(meta.path),
    '-t', toFFmpegTime(requestedDuration),
    '-map', '0',
    '-dn',
    '-ignore_unknown',
  ]

  if (isCopy) {
    argv.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
  } else {
    argv.push(...buildCompressEncodeArgs(meta, encoder))
  }

  argv.push(toPosixPath(outPath))

  return { label, bin: 'ffmpeg', argv, expectedDurationSec: actualDuration }
}

/**
 * AMF 硬件 AV1 的 CQP 档位。AMF 的 QP 与 SVT-AV1 的 CRF 不直接可比，
 * 26 大致对应 CRF 28 的量级（可用 28 更小、24 更清晰，按需微调）。
 */
const AMF_QP = 26

/**
 * 压缩模式的编码参数：按编码器分支，音频轨直接 copy。
 *
 * 音频不重编码：视频体积通常占绝大部分，音频轨 copy 既省一次编码损失，
 * 也省了音频编码器兼容性判断。字幕轨按需 copy。
 *
 * - svtav1：软件编码，体积最优。pix_fmt 固定 yuv420p10le：SVT-AV1 在高于
 *   8bit 输入时默认切 10bit 内部处理，显式指定避免输出差异。
 * - amf：AMD 硬件编码（依赖独显），快 10~30 倍，同画质体积略大。
 *   CQP 用 min/max 相同值锁定量化档位；pix_fmt 用 8bit yuv420p（VCN 对 8bit
 *   兼容最好）。
 */
function buildCompressEncodeArgs(meta: VideoMeta, encoder: CompressEncoder): string[] {
  const args =
    encoder === 'amf'
      ? [
          '-c:v', 'av1_amf',
          '-rc', 'cqp',
          '-min_qp_i', String(AMF_QP),
          '-max_qp_i', String(AMF_QP),
          '-min_qp_p', String(AMF_QP),
          '-max_qp_p', String(AMF_QP),
          '-quality', 'quality',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'copy',
        ]
      : [
          '-c:v', 'libsvtav1',
          '-crf', String(COMPRESS_CRF),
          '-preset', String(COMPRESS_PRESET),
          '-pix_fmt', 'yuv420p10le',
          '-c:a', 'copy',
        ]

  if (meta.streams.some((s) => s.codecType === 'subtitle')) {
    args.push('-c:s', 'copy')
  }

  return args
}

/**
 * 生成 concat demuxer 的列表文件内容。
 *
 * 用 concat demuxer 而不是 concat filter：demuxer 是纯容器层拼接、支持 -c copy、
 * 零重编码；filter 必须解码重编码，与"仅切分拼接"的需求直接矛盾。
 *
 * 路径中的单引号要转义成 '\'' —— demuxer 的语法要求。
 */
export function buildConcatListContent(segmentPaths: string[]): string {
  return (
    segmentPaths
      .map((p) => `file '${toPosixPath(p).replace(/'/g, "'\\''")}'`)
      .join('\n') + '\n'
  )
}

/** 构造拼接命令 */
export function buildConcatCommand(
  listPath: string,
  outPath: string,
  totalDurationSec: number
): CommandSpec {
  const argv: string[] = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-progress', 'pipe:1',
    '-nostats',
    '-f', 'concat',
    // 使用绝对路径的必要开关
    '-safe', '0',
    '-i', toPosixPath(listPath),
    '-map', '0',
    '-c', 'copy',
  ]

  // 只有 mp4 系容器支持 faststart，mkv 加了会报错
  if (FASTSTART_EXTS.has(extOf(outPath))) {
    argv.push('-movflags', '+faststart')
  }

  argv.push(toPosixPath(outPath))

  return {
    label: '拼接所有段落',
    bin: 'ffmpeg',
    argv,
    expectedDurationSec: totalDurationSec,
  }
}

/**
 * 构造一次完整任务的全部命令。
 *
 * @param tmpDir 临时目录（放中间段落文件和 concat 列表）
 * @returns commands 是按序执行的命令；segmentPaths / listPath / stagedOutput 供执行层使用
 */
export function buildJobCommands(
  meta: VideoMeta,
  segments: Segment[],
  mode: CutMode,
  encoder: CompressEncoder,
  outputPath: string,
  tmpDir: string
): {
  commands: CommandSpec[]
  segmentPaths: string[]
  listPath: string
  listContent: string
  stagedOutput: string
  totalDurationSec: number
  needsConcat: boolean
} {
  const ext = meta.ext || '.mp4'
  const segmentPaths = segments.map((_, i) =>
    joinPosix(tmpDir, `seg_${String(i).padStart(3, '0')}${ext}`)
  )

  const commands: CommandSpec[] = segments.map((seg, i) =>
    buildCutCommand(
      meta,
      seg,
      mode,
      encoder,
      segmentPaths[i],
      `切分第 ${i + 1}/${segments.length} 段`
    )
  )

  const totalDurationSec = commands.reduce(
    (sum, c) => sum + (c.expectedDurationSec ?? 0),
    0
  )

  const listPath = joinPosix(tmpDir, 'list.txt')
  const listContent = buildConcatListContent(segmentPaths)

  // 只有一段时跳过 concat，直接把 seg_000 改名成最终输出
  const needsConcat = segments.length > 1
  const stagedOutput = needsConcat
    ? joinPosix(tmpDir, `output${extOf(outputPath) || ext}`)
    : segmentPaths[0]

  if (needsConcat) {
    commands.push(buildConcatCommand(listPath, stagedOutput, totalDurationSec))
  }

  return {
    commands,
    segmentPaths,
    listPath,
    listContent,
    stagedOutput,
    totalDurationSec,
    needsConcat,
  }
}

/** 把 argv 渲染成可复制粘贴的命令行（仅用于展示，执行永远用 argv 数组） */
export function renderCommandLine(cmd: CommandSpec): string {
  const quote = (s: string) => (/[\s'"&|<>()$`]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)
  return [cmd.bin, ...cmd.argv.map(quote)].join(' ')
}

/** 计算默认输出路径：原目录 + 原文件名 + 后缀 + 原扩展名 */
export function buildOutputPath(meta: VideoMeta, suffix: string): string {
  return joinPosix(meta.dir, `${meta.base}${suffix}${meta.ext}`)
}
