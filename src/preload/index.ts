/**
 * preload：把主进程能力以白名单形式暴露给渲染进程。
 *
 * 刻意不暴露通用的 invoke(channel, ...) —— 那等于把整个 IPC 表面交出去。
 * 每个方法都是具体操作，签名固定。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CommandSpec, EnvStatus, JobEvent, JobRequest, VideoMeta } from '@shared/types'

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

  startJob: (req: JobRequest): Promise<{ jobId: string }> => ipcRenderer.invoke('job:start', req),

  cancelJob: (jobId: string): Promise<void> => ipcRenderer.invoke('job:cancel', jobId),

  reveal: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:reveal', filePath),

  checkOutput: (outputPath: string): Promise<OutputCheck> =>
    ipcRenderer.invoke('output:check', outputPath),

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
   * 从拖拽的 File 对象取真实磁盘路径。
   *
   * Electron 32 起 File.path 已被移除，必须用 webUtils.getPathForFile。
   * 这也是选 Electron 而非浏览器方案的核心原因 —— 浏览器 File API 拿不到路径。
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
