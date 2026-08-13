/**
 * IPC 通道注册。
 *
 * 每个通道都是显式声明的具体操作，preload 逐个包装 —— 不暴露通用的
 * invoke(channel, ...)，否则渲染进程被注入脚本时能调任意主进程能力。
 */

import { existsSync } from 'node:fs'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { JobRequest, PersistedSession, PersistedTask, VideoMeta } from '@shared/types'
import { renderCommandLine } from '@shared/commands'
import { resolveOutputPath } from '@shared/output'
import { parseTime } from '@shared/time'
import { setLogSink, logInfo } from './log'
import { loadJson, saveJson } from './storage'
import { TaskStore } from './tasks'
import { detectEncoderSupport, invalidateEnvCache, locateBinaries } from './ffmpeg/locate'
import { probeVideo } from './ffmpeg/probe'
import { snapSegments } from './ffmpeg/keyframes'
import { planJob } from './ffmpeg/job'
import { JobScheduler } from './ffmpeg/scheduler'
import { allowMediaPath, toMediaUrl } from './mediaProtocol'

/** 文件选择对话框的过滤器 */
const VIDEO_EXTS = [
  'mp4', 'mkv', 'mov', 'm4v', 'avi', 'webm', 'flv', 'wmv', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp',
]

/** 任务调度器：前台流复制 + 后台压缩队列 */
let scheduler: JobScheduler | null = null
/** 后台压缩任务的持久化列表 */
let taskStore: TaskStore | null = null

/** 应用退出时清理：杀光所有受管子进程，并把非终态任务标记为 interrupted */
export function shutdownJobs(): void {
  scheduler?.shutdown()
  taskStore?.markInterrupted()
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // 把主进程日志广播到渲染进程的日志面板（唯一出口，注册在其它任何日志之前）
  setLogSink((entry) => getWindow()?.webContents.send('log:event', entry))

  // 后台任务持久化：磁盘读写 + 每次变更广播给渲染层
  taskStore = new TaskStore({
    storage: {
      loadTasks: () => loadJson<PersistedTask[]>('tasks.json', []),
      saveTasks: (tasks) => saveJson('tasks.json', tasks),
    },
    broadcast: (task) => getWindow()?.webContents.send('task:event', task),
  })
  taskStore.load()

  // 任务事件按 jobId 广播；前台任务与后台队列走同一条通道。
  // 后台压缩任务的持久化状态由 taskStore 从这些事件里同步。
  scheduler = new JobScheduler({
    send: (jobId, event) => {
      getWindow()?.webContents.send('job:event', jobId, event)
      taskStore?.onJobEvent(jobId, event)
    },
  })

  ipcMain.handle('env:check', async (_e, force?: boolean) => {
    if (force) invalidateEnvCache()
    const env = await locateBinaries(force === true)
    logInfo(
      `环境：ffmpeg=${env.ffmpeg ?? '未找到'}，ffprobe=${env.ffprobe ?? '未找到'}` +
        (env.version ? `（${env.version}）` : '')
    )
    return env
  })

  /** 编码器可用性（是否有 av1_amf 硬件编码器），带缓存 */
  ipcMain.handle('env:encoders', async (_e, force?: boolean) => {
    return detectEncoderSupport(force === true)
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

  ipcMain.handle('job:start', (_e, req: JobRequest) => {
    if (!scheduler || !taskStore) throw new Error('调度器未初始化')
    // 自动识别重复任务：同源视频 + 同后缀的压缩任务已在排队/执行时拒绝重复提交
    if (req.mode === 'compress' && taskStore.hasActiveDuplicate(req)) {
      throw new Error('已有相同的压缩任务（同源视频和输出后缀）在排队或执行，请先完成或取消')
    }
    const r = scheduler.start(req)
    // 压缩任务进入后台队列 → 持久化；前台流复制是即时操作，不存
    if (r.lane === 'bg') taskStore.enqueue(r.jobId, req)
    return r
  })

  ipcMain.handle('job:cancel', (_e, jobId: string) => {
    scheduler?.cancel(jobId)
  })

  /** 队列快照：渲染层重载后恢复前台/后台任务的视图 */
  ipcMain.handle('job:queueSnapshot', () => {
    if (!scheduler) throw new Error('调度器未初始化')
    return scheduler.getSnapshot()
  })

  // ── 后台任务持久化 ──────────────────────

  ipcMain.handle('task:list', () => {
    if (!taskStore) throw new Error('任务存储未初始化')
    return taskStore.list()
  })

  /**
   * 重新运行已保存的压缩任务：重新探测源视频，用保存的起终点重新入队。
   * 不从中断处续传（AV1 无法单次断点续传），但配置完整保留，无需重设。
   */
  ipcMain.handle('task:resume', async (_e, taskId: string) => {
    if (!scheduler || !taskStore) throw new Error('调度器未初始化')
    const task = taskStore.get(taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)

    const meta = await probeVideo(task.inputPath)
    const segments = task.segments.map((s, i) => ({
      id: `seg-${i}`,
      startRaw: s.startRaw,
      endRaw: s.endRaw,
      startSec: parseTime(s.startRaw),
      endSec: parseTime(s.endRaw),
    }))
    const req: JobRequest = {
      input: meta,
      segments,
      mode: task.mode,
      encoder: task.encoder ?? 'svtav1',
      outputPath: task.outputPath,
      suffix: task.suffix,
    }
    const r = scheduler.start(req)
    taskStore.resume(taskId, r.jobId, req)
    return r
  })

  ipcMain.handle('task:delete', (_e, taskId: string) => {
    taskStore?.delete(taskId)
  })

  /** 载入编辑：把任务的时间段/mode/后缀/编码器恢复到编辑器，供微调后再跑 */
  ipcMain.handle('task:loadIntoEditor', (_e, taskId: string) => {
    const task = taskStore?.get(taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)
    return {
      inputPath: task.inputPath,
      segments: task.segments,
      mode: task.mode,
      suffix: task.suffix,
      encoder: task.encoder ?? 'svtav1',
    }
  })

  // ── 编辑会话持久化（下次打开自动恢复时间段） ──

  ipcMain.handle('session:save', (_e, session: PersistedSession) => {
    saveJson('session.json', session)
  })

  ipcMain.handle('session:load', () => loadJson<PersistedSession | null>('session.json', null))

  ipcMain.handle('session:clear', () => {
    saveJson('session.json', null)
  })

  ipcMain.handle('shell:reveal', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  /**
   * 检查输出路径是否已存在，并给出一个可用的备选名。
   * 不静默覆盖用户目录里的文件 —— 由 UI 让用户明确选择。
   * 与调度器共用 resolveOutputPath，保证改名规则两端一致。
   */
  ipcMain.handle('output:check', (_e, outputPath: string) => {
    const exists = existsSync(outputPath)
    return { exists, alternative: resolveOutputPath(outputPath, existsSync) }
  })
}
