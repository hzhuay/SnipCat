/**
 * 应用状态。
 *
 * 状态不复杂，用 useReducer 而不是引入状态库 —— 少一个依赖。
 * 校验和命令构造都在 shared 的纯函数里，这里只管状态迁移。
 */

import { useReducer } from 'react'
import type {
  CompressEncoder,
  CutMode,
  EnvStatus,
  JobEvent,
  JobStage,
  LogEntry,
  Segment,
  TaskState,
  VideoMeta,
} from '@shared/types'
import { DEFAULT_SUFFIX } from '@shared/types'
import { parseTime } from '@shared/time'
import type { PlannedCommand } from '../../preload'

export interface JobState {
  jobId: string | null
  stage: JobStage | null
  stageIndex?: number
  stageTotal?: number
  ratio: number
  etaSec?: number
  commands: PlannedCommand[]
  /** 完成信息 */
  result: { outputPath: string; elapsedSec: number } | null
  error: { message: string; stderrTail: string[] } | null
  canceled: boolean
}

export interface State {
  env: EnvStatus | null
  meta: VideoMeta | null
  mediaUrl: string | null
  /** 元数据探测中 / 探测失败 */
  probing: boolean
  probeError: string | null
  segments: Segment[]
  mode: CutMode
  /** 压缩模式使用的编码器 */
  encoder: CompressEncoder
  suffix: string
  dryRun: boolean
  job: JobState
  /** Dry-run 的结果（不进入 job 状态） */
  plan: PlannedCommand[] | null
  planning: boolean
  /** 全局处理日志（探测、吸附、切分、拼接的全部中间过程） */
  logs: LogEntry[]
  /** 后台压缩任务列表（含历史/已中断任务，task:event 实时更新） */
  tasks: TaskState[]
}

const emptyJob: JobState = {
  jobId: null,
  stage: null,
  ratio: 0,
  commands: [],
  result: null,
  error: null,
  canceled: false,
}

let segSeq = 0
function newSegment(startRaw = '', endRaw = ''): Segment {
  return {
    id: `seg-${++segSeq}`,
    startRaw,
    endRaw,
    startSec: parseTime(startRaw),
    endSec: parseTime(endRaw),
  }
}

/** 从持久化/保存的原始字符串重建时间段列表（恢复会话、载入任务到编辑器用） */
function segmentsFromRaw(list: { startRaw: string; endRaw: string }[]): Segment[] {
  return list.map((s) => newSegment(s.startRaw, s.endRaw))
}

export const initialState: State = {
  env: null,
  meta: null,
  mediaUrl: null,
  probing: false,
  probeError: null,
  segments: [newSegment()],
  // 默认压缩模式 + 硬件 AV1（AMF）：速度优先；amf 不可用时 App 会回退 svtav1
  mode: 'compress',
  encoder: 'amf',
  suffix: '_cut_compressed',
  // 开发期默认勾选：mac 上没有 ffmpeg，先看命令
  dryRun: false,
  job: emptyJob,
  plan: null,
  planning: false,
  logs: [],
  tasks: [],
}

export type Action =
  | { type: 'env/loaded'; env: EnvStatus }
  | { type: 'probe/start' }
  | { type: 'probe/success'; meta: VideoMeta; mediaUrl: string | null }
  | { type: 'probe/failure'; message: string }
  | { type: 'file/clear' }
  | { type: 'seg/add' }
  | { type: 'seg/addWith'; startRaw?: string; endRaw?: string }
  | { type: 'seg/remove'; id: string }
  | { type: 'seg/edit'; id: string; field: 'startRaw' | 'endRaw'; value: string }
  | { type: 'seg/normalize'; id: string; field: 'startRaw' | 'endRaw'; value: string }
  | { type: 'seg/move'; from: number; to: number }
  | { type: 'seg/sort' }
  | { type: 'seg/clearSnaps' }
  | { type: 'seg/applySnaps'; snaps: Array<{ startSec: number; endSec: number }>; ids: string[] }
  | { type: 'mode/set'; mode: CutMode }
  | { type: 'encoder/set'; encoder: CompressEncoder }
  | { type: 'prefs/loaded'; prefs: { mode: CutMode; encoder: CompressEncoder } }
  | { type: 'suffix/set'; suffix: string }
  | { type: 'dryRun/set'; value: boolean }
  | { type: 'plan/start' }
  | { type: 'plan/done'; commands: PlannedCommand[] }
  | { type: 'plan/failed'; message: string }
  | { type: 'plan/clear' }
  | { type: 'job/started'; jobId: string }
  | { type: 'job/event'; event: JobEvent }
  | { type: 'job/reset' }
  | { type: 'log/add'; entry: LogEntry }
  | { type: 'log/clear' }
  | { type: 'task/list'; tasks: TaskState[] }
  | { type: 'task/upsert'; task: TaskState }
  | { type: 'task/delete'; taskId: string }
  | {
      type: 'session/restored'
      meta: VideoMeta
      mediaUrl: string | null
      segments: { startRaw: string; endRaw: string }[]
      mode: CutMode
      suffix: string
      encoder: CompressEncoder
    }

/** 编辑输入框时同步解析结果，并清掉该端已有的吸附值（时间变了吸附就失效） */
function editSegment(
  segments: Segment[],
  id: string,
  field: 'startRaw' | 'endRaw',
  value: string
): Segment[] {
  return segments.map((s) => {
    if (s.id !== id) return s
    const next: Segment = { ...s, [field]: value }
    next.startSec = parseTime(next.startRaw)
    next.endSec = parseTime(next.endRaw)
    if (field === 'startRaw') next.snappedStartSec = undefined
    else next.snappedEndSec = undefined
    return next
  })
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'env/loaded':
      return { ...state, env: action.env }

    case 'probe/start':
      // 新文件 = 新日志会话：清空上一份的日志，探测本身的过程会重新记进来
      return { ...state, probing: true, probeError: null, logs: [] }

    case 'probe/success':
      return {
        ...state,
        probing: false,
        probeError: null,
        meta: action.meta,
        mediaUrl: action.mediaUrl,
        // 换新文件后，之前记录的时间段、吸附结果和计划全部清空，从一行空段落开始
        segments: [newSegment()],
        plan: null,
        job: emptyJob,
      }

    case 'probe/failure':
      return { ...state, probing: false, probeError: action.message, meta: null, mediaUrl: null }

    // 恢复上次的编辑会话：等价于 probe/success，但时间段/mode/后缀来自保存的值
    case 'session/restored':
      return {
        ...state,
        probing: false,
        probeError: null,
        meta: action.meta,
        mediaUrl: action.mediaUrl,
        segments: segmentsFromRaw(action.segments),
        mode: action.mode,
        suffix: action.suffix,
        encoder: action.encoder,
        plan: null,
        job: emptyJob,
        logs: [],
      }

    case 'file/clear':
      return {
        ...state,
        meta: null,
        mediaUrl: null,
        probeError: null,
        plan: null,
        job: emptyJob,
        logs: [],
      }

    case 'seg/add':
      return { ...state, segments: [...state.segments, newSegment()], plan: null }

    case 'seg/addWith':
      return {
        ...state,
        segments: [...state.segments, newSegment(action.startRaw ?? '', action.endRaw ?? '')],
        plan: null,
      }

    case 'seg/remove': {
      const rest = state.segments.filter((s) => s.id !== action.id)
      // 至少留一行，否则界面上没有可编辑的地方
      return { ...state, segments: rest.length > 0 ? rest : [newSegment()], plan: null }
    }

    case 'seg/edit':
    case 'seg/normalize':
      return {
        ...state,
        segments: editSegment(state.segments, action.id, action.field, action.value),
        plan: null,
      }

    case 'seg/move': {
      const next = [...state.segments]
      const [moved] = next.splice(action.from, 1)
      if (!moved) return state
      next.splice(action.to, 0, moved)
      return { ...state, segments: next, plan: null }
    }

    case 'seg/sort':
      return {
        ...state,
        segments: [...state.segments].sort((a, b) => (a.startSec ?? Infinity) - (b.startSec ?? Infinity)),
        plan: null,
      }

    case 'seg/clearSnaps':
      return {
        ...state,
        segments: state.segments.map((s) => ({
          ...s,
          snappedStartSec: undefined,
          snappedEndSec: undefined,
        })),
      }

    case 'seg/applySnaps': {
      // ids 与 snaps 一一对应；按 id 回填，避免期间列表增删导致错位
      const byId = new Map<string, { startSec: number; endSec: number }>()
      action.ids.forEach((id, i) => {
        const snap = action.snaps[i]
        if (snap) byId.set(id, snap)
      })
      return {
        ...state,
        segments: state.segments.map((s) => {
          const snap = byId.get(s.id)
          if (!snap) return s
          return { ...s, snappedStartSec: snap.startSec, snappedEndSec: snap.endSec }
        }),
      }
    }

    case 'mode/set':
      // 切换模式时清掉吸附值，避免显示错的实际切点
      // 后缀若还是旧模式的默认值（即用户没改过），随模式切到新默认；改过则保留
      return {
        ...state,
        mode: action.mode,
        suffix:
          state.suffix === DEFAULT_SUFFIX[state.mode]
            ? DEFAULT_SUFFIX[action.mode]
            : state.suffix,
        segments: state.segments.map((s) => ({
          ...s,
          snappedStartSec: undefined,
          snappedEndSec: undefined,
        })),
        plan: null,
      }

    case 'encoder/set':
      return { ...state, encoder: action.encoder, plan: null }

    case 'prefs/loaded':
      // 启动时应用用户偏好：模式 + 编码器；后缀跟随模式到对应默认值
      // （随后若有编辑会话恢复，会用会话里的值再覆盖一遍）
      return {
        ...state,
        mode: action.prefs.mode,
        encoder: action.prefs.encoder,
        suffix: DEFAULT_SUFFIX[action.prefs.mode],
      }

    case 'suffix/set':
      return { ...state, suffix: action.suffix, plan: null }

    case 'dryRun/set':
      return { ...state, dryRun: action.value }

    case 'plan/start':
      return { ...state, planning: true, plan: null }

    case 'plan/done':
      return { ...state, planning: false, plan: action.commands }

    case 'plan/failed':
      return { ...state, planning: false, probeError: action.message }

    case 'plan/clear':
      return { ...state, plan: null }

    case 'job/started':
      return { ...state, job: { ...emptyJob, jobId: action.jobId }, plan: null }

    case 'job/event':
      return { ...state, job: applyJobEvent(state.job, action.event) }

    case 'job/reset':
      return { ...state, job: emptyJob }

    case 'log/add':
      return { ...state, logs: [...state.logs, action.entry].slice(-MAX_LOG_LINES) }

    case 'log/clear':
      return { ...state, logs: [] }

    case 'task/list':
      return { ...state, tasks: action.tasks }

    case 'task/upsert': {
      const i = state.tasks.findIndex((t) => t.id === action.task.id)
      if (i < 0) return { ...state, tasks: [action.task, ...state.tasks] }
      const tasks = [...state.tasks]
      tasks[i] = action.task
      return { ...state, tasks }
    }

    case 'task/delete':
      return { ...state, tasks: state.tasks.filter((t) => t.id !== action.taskId) }

    default:
      return state
  }
}

/** 保留的日志行数上限，避免长任务把内存吃掉 */
const MAX_LOG_LINES = 800

function applyJobEvent(job: JobState, e: JobEvent): JobState {
  switch (e.type) {
    case 'plan':
      return { ...job, commands: e.commands.map((c) => ({ ...c, line: '' })) }
    case 'stage':
      return { ...job, stage: e.stage, stageIndex: e.index, stageTotal: e.total }
    case 'progress':
      return { ...job, ratio: e.ratio, etaSec: e.etaSec }
    case 'done':
      return { ...job, ratio: 1, stage: null, result: { outputPath: e.outputPath, elapsedSec: e.elapsedSec } }
    case 'error':
      return { ...job, stage: null, error: { message: e.message, stderrTail: e.stderrTail } }
    case 'canceled':
      return { ...job, stage: null, canceled: true }
    default:
      return job
  }
}

export function useAppState() {
  return useReducer(reducer, initialState)
}
