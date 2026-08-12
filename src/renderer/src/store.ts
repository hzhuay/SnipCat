/**
 * 应用状态。
 *
 * 状态不复杂，用 useReducer 而不是引入状态库 —— 少一个依赖。
 * 校验和命令构造都在 shared 的纯函数里，这里只管状态迁移。
 */

import { useReducer } from 'react'
import type { CutMode, EnvStatus, JobEvent, JobStage, Segment, VideoMeta } from '@shared/types'
import { parseTime } from '@shared/time'
import type { PlannedCommand } from '../../preload'

export interface JobState {
  jobId: string | null
  stage: JobStage | null
  stageIndex?: number
  stageTotal?: number
  ratio: number
  etaSec?: number
  logs: string[]
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
  suffix: string
  dryRun: boolean
  job: JobState
  /** Dry-run 的结果（不进入 job 状态） */
  plan: PlannedCommand[] | null
  planning: boolean
}

const emptyJob: JobState = {
  jobId: null,
  stage: null,
  ratio: 0,
  logs: [],
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

export const initialState: State = {
  env: null,
  meta: null,
  mediaUrl: null,
  probing: false,
  probeError: null,
  segments: [newSegment()],
  mode: 'copy',
  suffix: '_cut',
  // 开发期默认勾选：mac 上没有 ffmpeg，先看命令
  dryRun: false,
  job: emptyJob,
  plan: null,
  planning: false,
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
  | { type: 'suffix/set'; suffix: string }
  | { type: 'dryRun/set'; value: boolean }
  | { type: 'plan/start' }
  | { type: 'plan/done'; commands: PlannedCommand[] }
  | { type: 'plan/failed'; message: string }
  | { type: 'plan/clear' }
  | { type: 'job/started'; jobId: string }
  | { type: 'job/event'; event: JobEvent }
  | { type: 'job/reset' }

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
      return { ...state, probing: true, probeError: null }

    case 'probe/success':
      return {
        ...state,
        probing: false,
        probeError: null,
        meta: action.meta,
        mediaUrl: action.mediaUrl,
        // 换文件后旧的吸附结果和计划全部失效
        segments: state.segments.map((s) => ({
          ...s,
          snappedStartSec: undefined,
          snappedEndSec: undefined,
        })),
        plan: null,
        job: emptyJob,
      }

    case 'probe/failure':
      return { ...state, probing: false, probeError: action.message, meta: null, mediaUrl: null }

    case 'file/clear':
      return { ...state, meta: null, mediaUrl: null, probeError: null, plan: null, job: emptyJob }

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
      // 精确模式不吸附，切换时清掉吸附值避免显示错的实际切点
      return {
        ...state,
        mode: action.mode,
        segments: state.segments.map((s) => ({
          ...s,
          snappedStartSec: undefined,
          snappedEndSec: undefined,
        })),
        plan: null,
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

    default:
      return state
  }
}

/** 保留的日志行数上限，避免长任务把内存吃掉 */
const MAX_LOG_LINES = 400

function applyJobEvent(job: JobState, e: JobEvent): JobState {
  switch (e.type) {
    case 'plan':
      return { ...job, commands: e.commands.map((c) => ({ ...c, line: '' })) }
    case 'stage':
      return { ...job, stage: e.stage, stageIndex: e.index, stageTotal: e.total }
    case 'progress':
      return { ...job, ratio: e.ratio, etaSec: e.etaSec }
    case 'log': {
      const logs = [...job.logs, e.line]
      return { ...job, logs: logs.slice(-MAX_LOG_LINES) }
    }
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
