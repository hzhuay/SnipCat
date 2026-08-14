/**
 * preload：把主进程能力以白名单形式暴露给渲染进程。
 *
 * 刻意不暴露通用的 invoke(channel, ...) —— 那等于把整个 IPC 表面交出去。
 * 每个方法都是具体操作，签名固定。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  CacheUsage,
  CommandSpec,
  CompressEncoder,
  CutMode,
  EnvStatus,
  JobEvent,
  JobRequest,
  LogEntry,
  PersistedSession,
  QueueSnapshot,
  TaskState,
  VideoMeta,
} from '@shared/types'

/** Dry-run 面板用的命令 + 渲染好的命令行文本 */
export interface PlannedCommand extends CommandSpec {
  line: string
}

export interface OutputCheck {
  exists: boolean
  alternative: string
}

const api = {
  /** 探测 ffmpeg / ffprobe；force 为 true 时忽略缓存重新检测 */
  checkEnv: (force?: boolean): Promise<EnvStatus> => ipcRenderer.invoke('env:check', force),

  /** 探测可用压缩编码器（如是否支持 av1_amf 硬件编码） */
  checkEncoders: (force?: boolean): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('env:encoders', force),

  pickVideo: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickVideo'),

  probe: (filePath: string): Promise<VideoMeta> => ipcRenderer.invoke('video:probe', filePath),

  mediaUrl: (filePath: string): Promise<string> => ipcRenderer.invoke('video:mediaUrl', filePath),

  /**
   * 批量求切点吸附结果。传入每段的 [起点, 终点]，返回等长的实际切点数组。
   * 起点向前、终点向后，两端都吸附到真实帧时间戳（可能有多位小数）。
   */
  snapSegments: (
    filePath: string,
    targets: Array<[number, number]>,
    durationSec: number
  ): Promise<Array<{ startSec: number; endSec: number }>> =>
    ipcRenderer.invoke('video:snap', filePath, targets, durationSec),

  planJob: (req: JobRequest): Promise<PlannedCommand[]> => ipcRenderer.invoke('job:plan', req),

  /**
   * 启动任务。copy → 前台（lane 'fg'）；compress → 后台队列（lane 'bg'）。
   * 前台任务的事件经 onJobEvent 推送，后台任务的事件按 jobId 进入队列视图。
   */
  startJob: (req: JobRequest): Promise<{ jobId: string; lane: 'fg' | 'bg' }> =>
    ipcRenderer.invoke('job:start', req),

  cancelJob: (jobId: string): Promise<void> => ipcRenderer.invoke('job:cancel', jobId),

  /** 后台队列快照（渲染层重载后恢复视图） */
  getQueue: (): Promise<QueueSnapshot> => ipcRenderer.invoke('job:queueSnapshot'),

  // ── 后台任务持久化 ──

  listTasks: (): Promise<TaskState[]> => ipcRenderer.invoke('task:list'),

  resumeTask: (taskId: string): Promise<{ jobId: string; lane: 'fg' | 'bg' }> =>
    ipcRenderer.invoke('task:resume', taskId),

  deleteTask: (taskId: string): Promise<void> => ipcRenderer.invoke('task:delete', taskId),

  loadTaskIntoEditor: (
    taskId: string
  ): Promise<{
    inputPath: string
    segments: { startRaw: string; endRaw: string }[]
    mode: CutMode
    suffix: string
    encoder: CompressEncoder
  }> => ipcRenderer.invoke('task:loadIntoEditor', taskId),

  // ── 编辑会话持久化 ──

  saveSession: (session: PersistedSession): Promise<void> =>
    ipcRenderer.invoke('session:save', session),

  loadSession: (): Promise<PersistedSession | null> => ipcRenderer.invoke('session:load'),

  clearSession: (): Promise<void> => ipcRenderer.invoke('session:clear'),

  /**
   * 订阅后台任务列表更新（task:event 推送完整任务）。
   * 返回取消订阅函数。
   */
  onTaskEvent: (cb: (task: TaskState) => void): (() => void) => {
    const listener = (_e: unknown, task: TaskState) => cb(task)
    ipcRenderer.on('task:event', listener)
    return () => ipcRenderer.removeListener('task:event', listener)
  },

  reveal: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:reveal', filePath),

  checkOutput: (outputPath: string): Promise<OutputCheck> =>
    ipcRenderer.invoke('output:check', outputPath),

  // ── 缓存清理 ──

  /** 查看残留的孤儿临时目录占用（不删除） */
  getCacheUsage: (): Promise<CacheUsage> => ipcRenderer.invoke('cache:usage'),

  /** 清理残留的孤儿临时目录，返回释放的字节数 */
  clearCache: (): Promise<{ freedBytes: number }> => ipcRenderer.invoke('cache:clear'),

  /**
   * 订阅任务事件。返回取消订阅函数。
   *
   * 必须包一层再转发，不能把 IpcRendererEvent 交给渲染进程 —— 它上面挂着
   * sender，等于泄漏了完整的 ipcRenderer 能力。
   */
  onJobEvent: (cb: (jobId: string, event: JobEvent) => void): (() => void) => {
    const listener = (_e: unknown, jobId: string, event: JobEvent) => cb(jobId, event)
    ipcRenderer.on('job:event', listener)
    return () => ipcRenderer.removeListener('job:event', listener)
  },

  /**
   * 订阅全局处理日志（探测、吸附、切分、拼接的所有中间过程）。
   * 返回取消订阅函数。
   */
  onLogEvent: (cb: (entry: LogEntry) => void): (() => void) => {
    const listener = (_e: unknown, entry: LogEntry) => cb(entry)
    ipcRenderer.on('log:event', listener)
    return () => ipcRenderer.removeListener('log:event', listener)
  },

  /**
   * 从拖拽的 File 对象取真实磁盘路径。
   *
   * Electron 32 起 File.path 已被移除，必须用 webUtils.getPathForFile。
   * 这也是选 Electron 而非浏览器方案的核心原因 —— 浏览器 File API 拿不到路径。
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
