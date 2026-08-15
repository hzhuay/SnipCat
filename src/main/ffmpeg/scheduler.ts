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

/** 暂停来源：手动按钮 / 游戏自动检测 / 前台抢占 */
export type PauseReason = 'manual' | 'game' | 'fg'

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
  /** 用户手动暂停（任务级，开关） */
  manualPaused: boolean
  /** 当前生效的暂停原因（paused 时有效） */
  pauseReason: PauseReason | null
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
  /** 检测到游戏在运行：对当前及后续所有后台任务降级 */
  private gameActive = false
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
      manualPaused: false,
      pauseReason: null,
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

  /**
   * 手动暂停一个运行中的任务（用户点按钮）。
   *
   * 通过降低进程优先级实现（throttle），不是冻结——ffmpeg 仍在写文件，安全；
   * 只是几乎不吃 CPU。排队中/已结束的任务忽略（没有可降级的进程）。
   */
  pause(jobId: string): void {
    if (this.bgCurrent?.jobId !== jobId) return
    this.bgCurrent.manualPaused = true
    this.syncPause(this.bgCurrent)
  }

  /** 恢复手动暂停的任务。仅当无其它暂停原因（游戏/前台抢占）时真正恢复。 */
  resume(jobId: string): void {
    if (this.bgCurrent?.jobId !== jobId) return
    this.bgCurrent.manualPaused = false
    this.syncPause(this.bgCurrent)
  }

  /**
   * 游戏状态变化：开始游戏 → 降级当前及后续所有后台压缩；退出游戏 → 恢复。
   * 这是全局开关（不针对单个任务），因为游戏期间新入队的任务也应自动降级。
   */
  setGameActive(active: boolean): void {
    this.gameActive = active
    if (this.bgCurrent) this.syncPause(this.bgCurrent)
  }

  /**
   * 依据当前所有暂停原因（手动 / 游戏 / 前台抢占）统一推进任务状态：
   * 同步降级、status、paused/resumed 事件。任何原因存在 → paused；全无 → running。
   */
  private syncPause(e: Entry): void {
    const throttled = e.manualPaused || this.gameActive
    const shouldPause = throttled || (this.bgPaused && this.bgCurrent === e)
    const reason: PauseReason | null = shouldPause
      ? this.currentPauseReason(e)
      : null

    if (throttled) void e.handle.throttle()
    else void e.handle.unthrottle()

    if (e.status !== 'paused' && shouldPause) {
      e.status = 'paused'
      e.pauseAt = Date.now()
      e.pauseReason = reason
      this.send(e.jobId, { type: 'paused', reason: reason! })
    } else if (e.status === 'paused' && !shouldPause) {
      this.markResumed(e)
      e.pauseReason = null
      this.send(e.jobId, { type: 'resumed' })
    } else if (e.status === 'paused' && shouldPause && e.pauseReason !== reason) {
      // 暂停原因变化（如手动暂停中又开了游戏）：更新 reason，保持 paused
      e.pauseReason = reason
      this.send(e.jobId, { type: 'paused', reason: reason! })
    }
  }

  /** 当前生效的暂停原因（优先级：前台抢占 > 手动 > 游戏） */
  private currentPauseReason(e: Entry): PauseReason {
    if (this.bgPaused && this.bgCurrent === e) return 'fg'
    if (e.manualPaused) return 'manual'
    return 'game'
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
      await this.bgCurrent.handle.suspend() // 尽力而为；失败则前后台短暂并发
      this.syncPause(this.bgCurrent)
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
        await this.bgCurrent.handle.resume() // 先解除前台冻结；若还有手动/游戏暂停则保持降级
        this.syncPause(this.bgCurrent)
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
    // 游戏运行期间启动的任务：直接以降级优先级开始
    if (this.gameActive) this.syncPause(next)

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

  private markResumed(e: Entry): void {
    e.status = 'running'
    if (e.pauseAt !== null) {
      e.pausedSec += (Date.now() - e.pauseAt) / 1000
      e.pauseAt = null
    }
  }
}
