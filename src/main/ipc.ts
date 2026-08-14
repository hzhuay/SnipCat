/**
 * IPC 通道注册。
 *
 * 每个通道都是显式声明的具体操作，preload 逐个包装 —— 不暴露通用的
 * invoke(channel, ...)，否则渲染进程被注入脚本时能调任意主进程能力。
 */

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type {
  CacheUsage,
  JobRequest,
  PersistedPrefs,
  PersistedSession,
  PersistedTask,
  VideoMeta,
} from '@shared/types'
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
import { FFmpegError } from './ffmpeg/runner'
import { cleanupOrphanTmpDirs, scanOrphanTmpDirs } from './ffmpeg/tmpCleanup'
import { allowMediaPath, toMediaUrl } from './mediaProtocol'

/** 文件选择对话框的过滤器 */
const VIDEO_EXTS = [
  'mp4', 'mkv', 'mov', 'm4v', 'avi', 'webm', 'flv', 'wmv', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp',
]

/**
 * 把 handler 抛出的任意值归一化成可安全跨 IPC 传输的错误。
 *
 * Electron 对 handler 抛出的 Error 实例只序列化 message/stack，自定义字段
 * （如 FFmpegError.stderrTail）会丢失；抛普通对象则走结构化克隆，字段完整
 * 保留。所以这里统一转成 plain object 而非 Error 子类实例。
 */
export function toIpcError(e: unknown): { name: string; message: string; stderrTail?: string[] } {
  if (e instanceof FFmpegError) {
    return { name: e.name, message: e.message, stderrTail: e.stderrTail }
  }
  if (e instanceof Error) {
    return { name: e.name, message: e.message }
  }
  return { name: 'Error', message: String(e) }
}

/** ipcMain.handle 的包装：捕获 handler 抛出的任意错误，统一归一化后再抛出 */
function handle<Args extends unknown[], R>(
  channel: string,
  fn: (e: IpcMainInvokeEvent, ...args: Args) => R | Promise<R>
): void {
  ipcMain.handle(channel, async (e, ...args: Args) => {
    try {
      return await fn(e, ...args)
    } catch (err) {
      throw toIpcError(err)
    }
  })
}

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

  handle('env:check', async (_e, force?: boolean) => {
    if (force) invalidateEnvCache()
    const env = await locateBinaries(force === true)
    logInfo(
      `环境：ffmpeg=${env.ffmpeg ?? '未找到'}，ffprobe=${env.ffprobe ?? '未找到'}` +
        (env.version ? `（${env.version}）` : '')
    )
    return env
  })

  /** 编码器可用性（是否有 av1_amf 硬件编码器），带缓存 */
  handle('env:encoders', async (_e, force?: boolean) => {
    return detectEncoderSupport(force === true)
  })

  handle('dialog:pickVideo', async () => {
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

  handle('video:probe', async (_e, filePath: string): Promise<VideoMeta> => {
    const meta = await probeVideo(filePath)
    // 探测成功即视为用户显式选择，加入 media:// 白名单供预览播放
    allowMediaPath(filePath)
    return meta
  })

  handle('video:mediaUrl', (_e, filePath: string) => toMediaUrl(filePath))

  /**
   * 批量求切点吸附结果，供 UI 在执行前就显示真实切点与偏移。
   *
   * 键用「起点_终点」的字符串，因为 IPC 无法传 Map，而起点终点要成对返回。
   */
  handle(
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
  handle('job:plan', async (_e, req: JobRequest) => {
    const commands = await planJob(req)
    return commands.map((c) => ({ ...c, line: renderCommandLine(c) }))
  })

  handle('job:start', (_e, req: JobRequest) => {
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

  handle('job:cancel', (_e, jobId: string) => {
    scheduler?.cancel(jobId)
  })

  /** 队列快照：渲染层重载后恢复前台/后台任务的视图 */
  handle('job:queueSnapshot', () => {
    if (!scheduler) throw new Error('调度器未初始化')
    return scheduler.getSnapshot()
  })

  // ── 后台任务持久化 ──────────────────────

  handle('task:list', () => {
    if (!taskStore) throw new Error('任务存储未初始化')
    return taskStore.list()
  })

  /**
   * 重新运行已保存的压缩任务：重新探测源视频，用保存的起终点重新入队。
   * 不从中断处续传（AV1 无法单次断点续传），但配置完整保留，无需重设。
   */
  handle('task:resume', async (_e, taskId: string) => {
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

  handle('task:delete', (_e, taskId: string) => {
    taskStore?.delete(taskId)
  })

  /** 删除已完成任务的源视频文件（只允许 done；幂等，源已不存在视为成功） */
  handle('task:deleteSource', async (_e, taskId: string) => {
    if (!taskStore) throw new Error('任务存储未初始化')
    await taskStore.deleteSource(taskId)
  })

  /** 清除所有已结束任务（done/error/canceled），返回剩余列表供渲染层刷新 */
  handle('task:clearFinished', () => {
    if (!taskStore) throw new Error('任务存储未初始化')
    return taskStore.clearFinished()
  })

  /** 载入编辑：把任务的时间段/mode/后缀/编码器恢复到编辑器，供微调后再跑 */
  handle('task:loadIntoEditor', (_e, taskId: string) => {
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

  handle('session:save', (_e, session: PersistedSession) => {
    saveJson('session.json', session)
  })

  handle('session:load', () => loadJson<PersistedSession | null>('session.json', null))

  handle('session:clear', () => {
    saveJson('session.json', null)
  })

  // ── 用户偏好持久化（模式 + 编码器，与会话解耦，启动即应用） ──

  handle('prefs:load', () => loadJson<PersistedPrefs | null>('prefs.json', null))

  handle('prefs:save', (_e, prefs: PersistedPrefs) => {
    saveJson('prefs.json', prefs)
  })

  handle('shell:reveal', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  /**
   * 检查输出路径是否已存在，并给出一个可用的备选名。
   * 不静默覆盖用户目录里的文件 —— 由 UI 让用户明确选择。
   * 与调度器共用 resolveOutputPath，保证改名规则两端一致。
   */
  handle('output:check', (_e, outputPath: string) => {
    const exists = existsSync(outputPath)
    return { exists, alternative: resolveOutputPath(outputPath, existsSync) }
  })

  // ── 缓存清理 ──────────────────────
  // 缓存范围仅指系统临时目录下残留的中间产物（正常任务结束会自动清，这里是
  // 用户可见的保险手段）；session.json / tasks.json 是应用状态而非缓存，
  // 不在清理范围内，避免用户误删任务历史。

  /** 查看当前残留的孤儿临时目录占用，仅扫描不删除 */
  handle('cache:usage', (): CacheUsage => {
    const { dirs, totalBytes } = scanOrphanTmpDirs(tmpdir())
    return { dirCount: dirs.length, bytes: totalBytes }
  })

  /** 清理残留的孤儿临时目录，返回释放的字节数 */
  handle('cache:clear', (): { freedBytes: number } => {
    const freedBytes = cleanupOrphanTmpDirs(tmpdir())
    if (freedBytes > 0) logInfo(`清理缓存：释放 ${freedBytes} 字节`)
    return { freedBytes }
  })
}
