/**
 * 任务调度器：前台流复制 + 后台压缩队列。
 *
 * 两条轨道：
 *  - 前台（fg）：流复制（-c copy），同一时刻最多一个，用户可随时发起；发起时
 *    会挂起正在跑的后台压缩（释放 CPU/磁盘 IO），复制完成后恢复后台继续。
 *  - 后台（bg）：压缩（AV1 重编码），FIFO 队列，同一时刻最多跑一个；只在没有
 *    前台任务时运行。
 *
 * 不变量：任何时刻至多一个「活跃」的子进程 —— 被挂起的后台不算活跃，所以前台
 * 与后台不会真并发抢资源。
 *
 * 调度决策都在类内部（可用注入 fake runner 单测）；挂起/恢复是尽力而为，失败时
 * 降级为前后台短暂并发，不阻断主流程。
 */

import type { JobEvent, JobRequest, QueueSnapshot } from '@shared/types'
import { resolveOutputPath } from '@shared/output'
import { logError, logInfo } from '../log'
import { runJob } from './job'
import { killAllManaged, ProcessHandle } from './runner'

type Send = (jobId: string, event: JobEvent) => void
type Runner = (entry: Entry, emit: (e: JobEvent) => void) => Promise<void>

/** 调度器内部的任务条目（running/paused 都指正在占用的轨道） */
interface Entry {
  jobId: string
  req: JobRequest
  handle: ProcessHandle
  outputPath: string
  status: 'queued' | 'running' | 'paused'
  ratio: number
  etaSec?: number
  error?: { message: string; stderrTail: string[] }
  /** 累计被挂起的时间（秒），用于修正 ETA */
  pausedSec: number
  pauseAt: number | null
}

export class JobScheduler {
  private fg: Entry | null = null
  private fgStarting = false
  private bgQueue: Entry[] = []
  private bgCurrent: Entry | null = null
  private bgPaused = false
  private claimed = new Set<string>()
  private seq = 0
  private shuttingDown = false
  private send: Send
  private run: Runner

  constructor(deps: { send: Send; run?: Runner }) {
    this.send = deps.send
    this.run = deps.run ?? ((entry, emit) => runJob(entry.req, entry.handle, emit, {
      pausedSec: () => entry.pausedSec,
    }))
  }

  /**
   * 启动一个任务。
   *
   * copy → 前台（独占，立即抢占）；compress → 后台队列（FIFO）。
   * 前台已有任务时抛错；压缩永远不会被拒绝，只是排队。
   */
  start(req: JobRequest): { jobId: string; lane: 'fg' | 'bg' } {
    if (this.shuttingDown) throw new Error('应用正在退出，无法开始新任务')

    const jobId = `job-${++this.seq}`
    const entry: Entry = {
      jobId,
      req,
      handle: new ProcessHandle(),
      outputPath: req.outputPath,
      status: 'queued',
      ratio: 0,
      pausedSec: 0,
      pauseAt: null,
    }

    // 磁盘占用由渲染层 output:check + 用户确认处理（覆盖或改名）；
    // 调度器这里只对「队列里已 claim 的路径」去重，避免并发任务写同一个文件。
    const isClaimed = (p: string): boolean => this.claimed.has(p)

    if (req.mode === 'compress') {
      entry.outputPath = resolveOutputPath(req.outputPath, isClaimed)
      entry.req = { ...req, outputPath: entry.outputPath }
      this.claimed.add(entry.outputPath)
      this.bgQueue.push(entry)
      this.send(jobId, { type: 'queued', outputPath: entry.outputPath })
      // 延迟到当前调用栈结束再开始后台任务：start() 的调用方（ipc）需要在
      // drainBg 发 'started' 事件之前先建立 jobId→任务的持久化映射，否则首个
      // 任务的运行状态会丢失、永远显示为「排队中」。
      queueMicrotask(() => this.drainBg())
      return { jobId, lane: 'bg' }
    }

    // 前台流复制：独占
    if (this.fg || this.fgStarting) {
      throw new Error('已有前台任务在执行')
    }
    entry.outputPath = resolveOutputPath(req.outputPath, isClaimed)
    entry.req = { ...req, outputPath: entry.outputPath }
    this.claimed.add(entry.outputPath)
    void this.startFg(entry)
    return { jobId, lane: 'fg' }
  }

  /** 取消：前台 / 后台运行中 / 后台排队中。挂起中的任务用 taskkill 直接可杀。 */
  cancel(jobId: string): void {
    if (this.fg?.jobId === jobId) {
      this.fg.handle.cancel()
      return
    }
    if (this.bgCurrent?.jobId === jobId) {
      this.bgCurrent.handle.cancel()
      return
    }
    const i = this.bgQueue.findIndex((q) => q.jobId === jobId)
    if (i >= 0) {
      const [e] = this.bgQueue.splice(i, 1)
      this.claimed.delete(e.outputPath)
      this.send(jobId, { type: 'canceled' })
    }
  }

  /** 队列快照：渲染层重载后恢复视图 */
  getSnapshot(): QueueSnapshot {
    const list = this.bgCurrent ? [this.bgCurrent, ...this.bgQueue] : [...this.bgQueue]
    return {
      fg: this.fg ? { jobId: this.fg.jobId } : null,
      queue: list.map((e) => ({
        jobId: e.jobId,
        status: e.status,
        outputPath: e.outputPath,
        ratio: e.ratio,
        etaSec: e.etaSec,
        error: e.error,
      })),
    }
  }

  /** 应用退出：拒绝新任务并杀光所有受管子进程（含被挂起的） */
  shutdown(): void {
    this.shuttingDown = true
    killAllManaged()
  }

  /** 记录进度/错误并转发事件给渲染进程 */
  private emit(entry: Entry, e: JobEvent): void {
    if (e.type === 'progress') {
      entry.ratio = e.ratio
      entry.etaSec = e.etaSec
    } else if (e.type === 'error') {
      entry.error = { message: e.message, stderrTail: e.stderrTail }
    }
    this.send(entry.jobId, e)
  }

  /** 运行前台任务：先挂起后台压缩 → 跑前台 → 恢复后台 → 继续队列 */
  private async startFg(entry: Entry): Promise<void> {
    this.fgStarting = true
    this.fg = entry // 先占位，保证取消立即生效、队列不启动新后台

    if (this.bgCurrent && !this.bgPaused) {
      this.bgPaused = true
      this.markPaused(this.bgCurrent)
      this.send(this.bgCurrent.jobId, { type: 'paused' })
      await this.bgCurrent.handle.suspend() // 尽力而为；失败则前后台短暂并发
    }

    this.fgStarting = false
    logInfo(`前台任务开始：${entry.outputPath}`)
    try {
      await this.run(entry, (e) => this.emit(entry, e))
    } catch (err) {
      // runJob 理论上内部已捕获所有错误，但防御性兜底：若它在进入内部
      // try 之前就 reject（如 requireBinaries / makeTmpDir 失败），不发事件
      // 会导致渲染层 running 永久卡住、时间段被锁死不可编辑。
      logError(`前台任务异常中断：${(err as Error).message}`)
      this.emit(entry, { type: 'error', message: (err as Error).message, stderrTail: [] })
    } finally {
      this.fg = null
      this.claimed.delete(entry.outputPath)

      if (this.bgCurrent && this.bgPaused) {
        this.bgPaused = false
        this.markResumed(this.bgCurrent)
        this.send(this.bgCurrent.jobId, { type: 'resumed' })
        await this.bgCurrent.handle.resume() // 尽力而为；失败则后台保持挂起，用户可手动取消
      }
      this.drainBg()
    }
  }

  /** 依次启动后台队列里的压缩任务；仅在没有前台任务时运行 */
  private async drainBg(): Promise<void> {
    if (this.bgCurrent || this.fg || this.fgStarting) return
    const next = this.bgQueue.shift()
    if (!next) return

    this.bgCurrent = next
    next.status = 'running'
    logInfo(`后台任务开始：${next.outputPath}`)
    this.send(next.jobId, { type: 'started' })

    try {
      await this.run(next, (e) => this.emit(next, e))
    } catch (err) {
      // 同 startFg：runJob 异常中断也要发 error，否则渲染层对应队列项悬空
      logError(`后台任务异常中断：${(err as Error).message}`)
      this.emit(next, { type: 'error', message: (err as Error).message, stderrTail: [] })
    } finally {
      this.bgCurrent = null
      this.claimed.delete(next.outputPath)
      this.drainBg()
    }
  }

  private markPaused(e: Entry): void {
    e.status = 'paused'
    e.pauseAt = Date.now()
  }

  private markResumed(e: Entry): void {
    e.status = 'running'
    if (e.pauseAt !== null) {
      e.pausedSec += (Date.now() - e.pauseAt) / 1000
      e.pauseAt = null
    }
  }
}
