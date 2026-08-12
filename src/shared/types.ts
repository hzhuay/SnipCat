/**
 * 主进程与渲染进程共用的领域类型。
 *
 * 这里的类型是 IPC 的契约，两端都从这里 import，避免手写两份结构导致漂移。
 */

/** ffprobe 单条流的信息，字段名按 camelCase 归一化过（ffprobe 原始输出是 snake_case） */
export interface StreamInfo {
  index: number
  codecType: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown'
  codecName: string
  /** 编码档次，如 h264 的 "High" */
  profile?: string
  /** 编码级别 ×10，如 4.0 在 ffprobe 里是 40 */
  level?: number
  width?: number
  height?: number
  pixFmt?: string
  /** 分数形式的帧率字符串，如 "30000/1001"。保留分数是为了精确复刻 NTSC 帧率 */
  rFrameRate?: string
  bitRate?: number
  sampleRate?: number
  channels?: number
  channelLayout?: string
  colorPrimaries?: string
  colorTransfer?: string
  colorSpace?: string
  /** 语言等元数据标签 */
  tags?: Record<string, string>
}

/** 一个输入视频的完整描述 */
export interface VideoMeta {
  /** 绝对路径 */
  path: string
  /** 所在目录（输出也落在这里） */
  dir: string
  /** 不含扩展名的文件名 */
  base: string
  /** 含点的扩展名，如 ".mp4" */
  ext: string
  sizeBytes: number
  durationSec: number
  /** ffprobe 的 format_name，可能是逗号分隔的多个，如 "mov,mp4,m4a,3gp,3g2,mj2" */
  formatName: string
  bitRate?: number
  streams: StreamInfo[]
}

/**
 * 一个待切分的时间段。
 *
 * startRaw/endRaw 保留用户的原始输入并且永不改写，这样反复编辑输入框时
 * 不会被规范化逻辑搅乱光标和内容。
 */
export interface Segment {
  id: string
  startRaw: string
  endRaw: string
  /** parseTime 的结果，解析失败为 null */
  startSec: number | null
  endSec: number | null
  /**
   * 流复制模式下的实际起点：ffmpeg `-ss` 的真实落点（由主进程实测回填）。
   * 总是 ≤ startSec —— 向前吸附，宁可多带几帧也不丢内容。
   */
  snappedStartSec?: number
  /**
   * 流复制模式下的实际终点：向后扩到帧边界之后（由主进程回填）。
   * 总是 ≥ endSec，且不超过视频总时长。
   */
  snappedEndSec?: number
}

/** 切分模式：copy = 流复制无损但切点吸附关键帧；precise = 重编码但帧级精确 */
export type CutMode = 'copy' | 'precise'

/** 单段的校验结果 */
export interface SegmentIssue {
  segmentId: string
  level: 'error' | 'warning'
  message: string
}

/** 整体校验结果 */
export interface ValidationResult {
  issues: SegmentIssue[]
  /** 是否存在 error 级问题（存在则禁止执行） */
  hasError: boolean
  /** 有效段落的时长之和（秒），用于展示预计输出时长 */
  totalDurationSec: number
}

/** 一次切分任务的完整请求 */
export interface JobRequest {
  input: VideoMeta
  /** 已校验通过的段落，顺序即拼接顺序 */
  segments: Segment[]
  mode: CutMode
  /** 输出的最终绝对路径 */
  outputPath: string
}

/** 任务执行阶段 */
export type JobStage = 'probe' | 'keyframe' | 'cut' | 'concat' | 'finalize'

/** 主进程推送给渲染进程的任务事件 */
export type JobEvent =
  | { type: 'plan'; commands: CommandSpec[] }
  | { type: 'stage'; stage: JobStage; index?: number; total?: number }
  | { type: 'progress'; ratio: number; etaSec?: number }
  | { type: 'log'; line: string }
  | { type: 'done'; outputPath: string; elapsedSec: number }
  | { type: 'error'; message: string; stderrTail: string[] }
  | { type: 'canceled' }

/**
 * 一条待执行的命令。
 *
 * argv 是数组而非字符串 —— spawn 时 shell: false，含空格/中文/引号的路径天然安全。
 * Dry-run 面板展示的和真实执行的是同一个对象，不会出现「显示的命令 ≠ 跑的命令」。
 */
export interface CommandSpec {
  /** 人类可读的说明，如 "切分第 1/3 段" */
  label: string
  bin: 'ffmpeg' | 'ffprobe'
  argv: string[]
  /** 该命令预期产出的时长（秒），用于进度加权。拼接步骤为总时长 */
  expectedDurationSec?: number
}

/** ffmpeg / ffprobe 的可用性探测结果 */
export interface EnvStatus {
  ffmpeg: string | null
  ffprobe: string | null
  /** ffmpeg -version 的首行 */
  version?: string
}

/** 输出路径已存在时的处理方式 */
export type OverwritePolicy = 'overwrite' | 'rename'
