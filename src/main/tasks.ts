/**
 * 后台压缩任务的持久化。
 *
 * 只存「压缩」任务（前台流复制是即时操作，不存）。持久化的意义：
 *  - 压缩耗时，用户可能中途关掉软件去干别的；重开时任务还在，配置（源视频 +
 *    时间段 + 模式 + 后缀）完整保留，一键「重新运行」即可，不必重设起终点。
 *  - 「重新运行」= 用保存的配置重启压缩（AV1 无法单次断点续传）。
 *
 * TaskStore 是任务列表的单一事实来源：内存态 + 写盘 + 广播给渲染层。
 * 进度（ratio）只更新内存与广播，不写盘，避免高频 IO；只有状态迁移才落盘。
 * 与 Electron 解耦（storage 注入），方便单测。
 */

import { unlink } from 'node:fs/promises'
import type { JobEvent, JobRequest, PersistedTask, TaskState } from '@shared/types'

export interface TaskStorage {
  loadTasks(): PersistedTask[]
  saveTasks(tasks: PersistedTask[]): void
}

/** 默认删除源文件：文件已不存在（ENOENT）视为已删除，幂等不报错 */
async function defaultDeleteFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

/** 终态：不会再变化，退出时无需标记 interrupted */
const TERMINAL = new Set(['done', 'error', 'canceled'])

export class TaskStore {
  private tasks: TaskState[] = []
  private jobToTask = new Map<string, string>()
  private seq = 0
  private storage: TaskStorage
  private broadcast: (task: TaskState) => void
  private deleteFile: (path: string) => Promise<void>

  constructor(opts: {
    storage: TaskStorage
    /** 每次任务状态变化时推送完整任务给渲染层 */
    broadcast: (task: TaskState) => void
    /** 删除源视频文件（测试注入 mock）；默认 fs.unlink，文件已不存在视为成功 */
    deleteFile?: (path: string) => Promise<void>
  }) {
    this.storage = opts.storage
    this.broadcast = opts.broadcast
    this.deleteFile = opts.deleteFile ?? defaultDeleteFile
  }

  /** 启动时从磁盘读入，并让新任务 id 从已有最大值续号 */
  load(): void {
    this.tasks = this.storage.loadTasks().map((t) => ({ ...t, ratio: 0 }))
    for (const t of this.tasks) {
      const n = Number(t.id.replace(/^t-/, ''))
      if (Number.isFinite(n) && n > this.seq) this.seq = n
    }
  }

  list(): TaskState[] {
    return this.tasks
  }

  get(id: string): TaskState | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  /**
   * 是否已有「同源视频 + 同后缀」且仍在排队/执行/暂停的压缩任务。
   * 用户反复点「开始处理」时，用这个阻止产生内容重复的任务。
   */
  hasActiveDuplicate(req: JobRequest): boolean {
    return this.tasks.some(
      (t) =>
        (t.status === 'queued' || t.status === 'running' || t.status === 'paused') &&
        t.inputPath === req.input.path &&
        t.suffix === req.suffix
    )
  }

  /** 压缩任务入队：建任务、记 jobId 映射、落盘、广播 */
  enqueue(jobId: string, req: JobRequest): TaskState {
    const task: TaskState = {
      id: `t-${++this.seq}`,
      inputPath: req.input.path,
      segments: req.segments.map((s) => ({ startRaw: s.startRaw, endRaw: s.endRaw })),
      mode: req.mode,
      suffix: req.suffix,
      encoder: req.encoder,
      outputPath: req.outputPath,
      createdAt: Date.now(),
      status: 'queued',
      ratio: 0,
      jobId,
    }
    this.tasks.unshift(task)
    this.jobToTask.set(jobId, task.id)
    this.commit(task, true)
    return task
  }

  /** 重新运行：复用原 taskId，重置状态并入队（配置用 req 刷新） */
  resume(taskId: string, jobId: string, req: JobRequest): TaskState {
    const task = this.get(taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)
    task.inputPath = req.input.path
    task.segments = req.segments.map((s) => ({ startRaw: s.startRaw, endRaw: s.endRaw }))
    task.mode = req.mode
    task.suffix = req.suffix
    task.encoder = req.encoder
    task.outputPath = req.outputPath
    task.status = 'queued'
    task.error = undefined
    task.ratio = 0
    task.jobId = jobId
    this.jobToTask.set(jobId, task.id)
    this.commit(task, true)
    return task
  }

  delete(taskId: string): void {
    this.tasks = this.tasks.filter((t) => t.id !== taskId)
    for (const [jobId, id] of this.jobToTask) {
      if (id === taskId) this.jobToTask.delete(jobId)
    }
    this.storage.saveTasks(this.persistable())
  }

  /**
   * 删除已完成任务的源视频（输出已生成，删源才安全）。
   * 只允许 done 状态；删后标 sourceDeleted，重新运行/载入编辑将被禁用。
   * 幂等：源文件已不存在视为已删除。
   */
  async deleteSource(taskId: string): Promise<void> {
    const task = this.get(taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)
    if (task.status !== 'done') throw new Error('只有已完成的任务才能删除原视频')
    if (task.sourceDeleted) throw new Error('原视频已删除')
    await this.deleteFile(task.inputPath)
    task.sourceDeleted = true
    this.commit(task, true)
  }

  /**
   * 清除所有已结束的任务（done/error/canceled）。interrupted 保留（等待重新运行）。
   * 返回剩余列表，渲染层用它刷新视图。
   */
  clearFinished(): TaskState[] {
    const removed = this.tasks.filter((t) => TERMINAL.has(t.status))
    if (removed.length === 0) return this.tasks
    const removedIds = new Set(removed.map((t) => t.id))
    for (const [jobId, id] of this.jobToTask) {
      if (removedIds.has(id)) this.jobToTask.delete(jobId)
    }
    this.tasks = this.tasks.filter((t) => !TERMINAL.has(t.status))
    this.storage.saveTasks(this.persistable())
    return this.tasks
  }

  /** 应用退出：把非终态任务标 interrupted（内存调度器已丢，等待下次重新运行） */
  markInterrupted(): void {
    let changed = false
    for (const t of this.tasks) {
      if (!TERMINAL.has(t.status)) {
        t.status = 'interrupted'
        t.jobId = undefined
        changed = true
      }
    }
    if (changed) this.storage.saveTasks(this.persistable())
  }

  /** 调度器事件 → 更新任务状态/进度。进度不落盘，状态迁移才落盘。 */
  onJobEvent(jobId: string, event: JobEvent): void {
    const taskId = this.jobToTask.get(jobId)
    if (!taskId) return
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) return

    let changed = false
    switch (event.type) {
      case 'progress':
        task.ratio = event.ratio
        task.etaSec = event.etaSec
        break
      case 'started':
        task.status = 'running'
        task.jobId = jobId
        changed = true
        break
      case 'paused':
        task.status = 'paused'
        task.pausedReason = event.reason
        changed = true
        break
      case 'resumed':
        task.status = 'running'
        task.pausedReason = undefined
        changed = true
        break
      case 'done':
        task.status = 'done'
        task.error = undefined
        task.jobId = undefined
        changed = true
        break
      case 'error':
        task.status = 'error'
        task.error = event.message
        task.jobId = undefined
        changed = true
        break
      case 'canceled':
        task.status = 'canceled'
        task.jobId = undefined
        changed = true
        break
      default:
        break
    }
    this.broadcast(task)
    if (changed) this.storage.saveTasks(this.persistable())
  }

  /** 广播 + 可选落盘 */
  private commit(task: TaskState, persist: boolean): void {
    this.broadcast(task)
    if (persist) this.storage.saveTasks(this.persistable())
  }

  /** 写盘时剥掉运行时字段（ratio / etaSec / jobId） */
  private persistable(): PersistedTask[] {
    return this.tasks.map(({ ratio: _r, etaSec: _e, jobId: _j, ...rest }) => rest)
  }
}
