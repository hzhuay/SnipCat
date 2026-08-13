/**
 * 子进程执行的底层封装。
 *
 * 一律用 spawn + argv 数组、shell: false —— 绝不拼 shell 字符串。
 * 这样含空格、中文、`&`、单引号的路径全部天然安全，不需要任何转义逻辑。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { ProgressParser } from '@shared/progress'
import { logInfo } from '../log'
import { resumePid, suspendPid } from './suspend'

/** stderr 保留的尾部行数：ffmpeg 的真实错误几乎总在末尾 */
const STDERR_TAIL_LINES = 20

export interface RunResult {
  code: number | null
  stdout: string
  stderrTail: string[]
}

export class CanceledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CanceledError'
  }
}

/** 当前所有受管子进程的 pid，应用退出时统一清理 */
const managedPids = new Set<number>()

/**
 * 杀光所有受管子进程（应用退出清理）。
 *
 * 用 spawnSync 同步执行，确保退出前 taskkill 已落地；taskkill /T /F 对挂起
 * （NtSuspendProcess 冻结）的进程同样有效，无需先恢复。
 */
export function killAllManaged(): void {
  for (const pid of managedPids) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false })
    } catch {
      // 单进程失败不影响整体清理
    }
  }
  managedPids.clear()
}

/**
 * 进程句柄，用于取消 / 挂起正在执行的任务。
 *
 * 一个 Job 从头到尾共用一个 handle，内部记录当前活跃的子进程。挂起（suspend）
 * 供前台任务抢占后台压缩时用：冻结子进程释放 CPU/磁盘 IO，前台复制完成后恢复。
 * 挂起是"带标志的"——若抢占发生在两条命令之间（此刻没有子进程），标志位会
 * 让下一条命令 spawn 出来就立即挂起。
 */
export class ProcessHandle {
  private current: ChildProcess | null = null
  private canceled = false
  private suspended = false

  attach(child: ChildProcess): void {
    if (this.canceled) {
      // 取消发生在 spawn 之前，立刻杀掉刚起的进程
      killTree(child)
      return
    }
    managedPids.add(child.pid!)
    if (this.suspended) {
      // 挂起发生在两条命令之间：新起的进程立即挂起，不等它先跑起来
      void suspendPid(child.pid!)
    }
    this.current = child
  }

  detach(): void {
    if (this.current) managedPids.delete(this.current.pid!)
    this.current = null
  }

  /** 标记取消并终止当前子进程 */
  cancel(): void {
    this.canceled = true
    if (this.current) {
      killTree(this.current)
      this.current = null
    }
  }

  /** 冻结当前子进程（尽力而为）。无子进程时只置标志，下一条命令 attach 时立即挂起 */
  suspend(): Promise<void> {
    this.suspended = true
    const pid = this.current?.pid
    return pid ? suspendPid(pid) : Promise.resolve()
  }

  /** 恢复当前子进程（尽力而为）。 */
  resume(): Promise<void> {
    this.suspended = false
    const pid = this.current?.pid
    return pid ? resumePid(pid) : Promise.resolve()
  }

  get isCanceled(): boolean {
    return this.canceled
  }

  /** 在每个步骤开始前检查，已取消则抛出 */
  throwIfCanceled(): void {
    if (this.canceled) throw new CanceledError()
  }
}

/**
 * 终止进程树。
 *
 * Windows 上 child.kill() 无法可靠终止 ffmpeg（它不响应 Node 发送的信号，
 * 且可能有子进程残留），必须用 taskkill /T /F 杀整棵树。
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false })
    } catch {
      // taskkill 本身失败时兜底尝试常规 kill
      try {
        child.kill()
      } catch {
        /* 进程可能已退出 */
      }
    }
  } else {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 进程可能已退出 */
    }
  }
}

export interface RunOptions {
  /** 进度回调，参数是已输出的时长（秒） */
  onProgress?: (outTimeSec: number) => void
  /** 逐行的 stderr 回调，用于把日志推给 UI */
  onLog?: (line: string) => void
  handle?: ProcessHandle
}

/**
 * 执行一条命令并等待完成。
 *
 * stdout 走进度解析（ffmpeg 的 -progress pipe:1 输出在 stdout），
 * stderr 全量收集但只在失败时取尾部 —— 全量 stderr 对长视频可能有几 MB。
 */
export function run(bin: string, argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.handle?.isCanceled) {
      reject(new CanceledError())
      return
    }

    let child: ChildProcess
    try {
      child = spawn(bin, argv, { shell: false, windowsHide: true })
    } catch (e) {
      reject(new Error(`无法启动 ${bin}：${(e as Error).message}`))
      return
    }

    opts.handle?.attach(child)

    const parser = new ProgressParser()
    let stdout = ''
    const stderrLines: string[] = []
    let stderrBuf = ''

    child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      stdout += text
      if (opts.onProgress) {
        for (const u of parser.push(text)) opts.onProgress(u.outTimeSec)
      }
    })

    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf8')
      const lines = stderrBuf.split(/\r?\n/)
      stderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        stderrLines.push(line)
        // 只保留尾部，避免长视频的日志把内存吃掉
        if (stderrLines.length > STDERR_TAIL_LINES * 4) {
          stderrLines.splice(0, stderrLines.length - STDERR_TAIL_LINES * 2)
        }
        opts.onLog?.(line)
      }
    })

    child.on('error', (e) => {
      opts.handle?.detach()
      reject(new Error(`执行 ${bin} 失败：${e.message}`))
    })

    child.on('close', (code) => {
      opts.handle?.detach()

      if (stderrBuf.trim() !== '') stderrLines.push(stderrBuf)

      if (opts.handle?.isCanceled) {
        reject(new CanceledError())
        return
      }

      resolve({
        code,
        stdout,
        stderrTail: stderrLines.slice(-STDERR_TAIL_LINES),
      })
    })
  })
}

/**
 * 执行命令并要求退出码为 0，否则抛出带 stderr 尾部的错误。
 *
 * 每条实际执行的命令都会记入日志（含探测用的 ffprobe 命令），这样用户复制的
 * 日志里能看到完整调用链，而不只是最终那条 ffmpeg。
 */
export async function runChecked(
  bin: string,
  argv: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  logInfo(`$ ${[bin, ...argv].join(' ')}`)
  const r = await run(bin, argv, opts)
  if (r.code !== 0) {
    const err = new FFmpegError(
      `${bin} 退出码 ${r.code}`,
      r.stderrTail
    )
    throw err
  }
  return r
}

/** 带 stderr 尾部的错误，供 UI 展示真实原因 */
export class FFmpegError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string[]
  ) {
    super(message)
    this.name = 'FFmpegError'
  }
}
