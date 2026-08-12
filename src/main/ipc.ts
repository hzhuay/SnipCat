/**
 * IPC 通道注册。
 *
 * 每个通道都是显式声明的具体操作，preload 逐个包装 —— 不暴露通用的
 * invoke(channel, ...)，否则渲染进程被注入脚本时能调任意主进程能力。
 */

import { existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { JobEvent, JobRequest, VideoMeta } from '@shared/types'
import { renderCommandLine } from '@shared/commands'
import { invalidateEnvCache, locateBinaries } from './ffmpeg/locate'
import { probeVideo } from './ffmpeg/probe'
import { snapSegments } from './ffmpeg/keyframes'
import { planJob, runJob } from './ffmpeg/job'
import { ProcessHandle } from './ffmpeg/runner'
import { allowMediaPath, toMediaUrl } from './mediaProtocol'

/** 文件选择对话框的过滤器 */
const VIDEO_EXTS = [
  'mp4', 'mkv', 'mov', 'm4v', 'avi', 'webm', 'flv', 'wmv', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp',
]

/** 正在执行的任务，同一时刻只允许一个 */
let activeJob: { id: string; handle: ProcessHandle } | null = null
let jobSeq = 0

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('env:check', async (_e, force?: boolean) => {
    if (force) invalidateEnvCache()
    return locateBinaries(force === true)
  })

  ipcMain.handle('dialog:pickVideo', async () => {
    const win = getWindow()
    const options = {
      title: '选择视频文件',
      properties: ['openFile' as const],
      filters: [
        { name: '视频文件', extensions: VIDEO_EXTS },
        { name: '所有文件', extensions: ['*'] },
      ],
    }
    // 带父窗口时对话框是模态的，体验更好；窗口意外缺失时退回无父窗口形式
    const r = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths[0]
  })

  ipcMain.handle('video:probe', async (_e, filePath: string): Promise<VideoMeta> => {
    const meta = await probeVideo(filePath)
    // 探测成功即视为用户显式选择，加入 media:// 白名单供预览播放
    allowMediaPath(filePath)
    return meta
  })

  ipcMain.handle('video:mediaUrl', (_e, filePath: string) => toMediaUrl(filePath))

  /**
   * 批量求切点吸附结果，供 UI 在执行前就显示真实切点与偏移。
   *
   * 键用「起点_终点」的字符串，因为 IPC 无法传 Map，而起点终点要成对返回。
   */
  ipcMain.handle(
    'video:snap',
    async (
      _e,
      filePath: string,
      targets: Array<[number, number]>,
      durationSec: number
    ): Promise<Array<{ startSec: number; endSec: number }>> => {
      return snapSegments(filePath, targets, durationSec)
    }
  )

  /**
   * Dry-run：只构造命令，不执行任何写操作。
   * 同时返回渲染好的命令行文本，Dry-run 面板直接展示、可复制。
   */
  ipcMain.handle('job:plan', async (_e, req: JobRequest) => {
    const commands = await planJob(req)
    return commands.map((c) => ({ ...c, line: renderCommandLine(c) }))
  })

  ipcMain.handle('job:start', async (_e, req: JobRequest) => {
    if (activeJob) throw new Error('已有任务正在执行')

    const id = `job-${++jobSeq}`
    const handle = new ProcessHandle()
    activeJob = { id, handle }

    const emit = (event: JobEvent) => {
      getWindow()?.webContents.send('job:event', id, event)
    }

    // 不 await：让 invoke 立刻返回 jobId，进度通过 job:event 推送
    void runJob(req, handle, emit).finally(() => {
      if (activeJob?.id === id) activeJob = null
    })

    return { jobId: id }
  })

  ipcMain.handle('job:cancel', (_e, jobId: string) => {
    if (activeJob?.id === jobId) activeJob.handle.cancel()
  })

  ipcMain.handle('shell:reveal', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  /**
   * 检查输出路径是否已存在，并给出一个可用的备选名。
   * 不静默覆盖用户目录里的文件 —— 由 UI 让用户明确选择。
   */
  ipcMain.handle('output:check', (_e, outputPath: string) => {
    const exists = existsSync(outputPath)
    if (!exists) return { exists: false, alternative: outputPath }

    const dir = dirname(outputPath)
    const ext = extname(outputPath)
    const base = basename(outputPath, ext)
    let n = 2
    let candidate = join(dir, `${base}_${n}${ext}`)
    while (existsSync(candidate) && n < 1000) {
      n++
      candidate = join(dir, `${base}_${n}${ext}`)
    }
    return { exists: true, alternative: candidate.replace(/\\/g, '/') }
  })
}
