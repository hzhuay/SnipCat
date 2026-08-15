import { describe, it, expect } from 'vitest'
import type { CutMode, JobEvent, JobRequest } from '../src/shared/types'
import { JobScheduler } from '../src/main/ffmpeg/scheduler'

function req(mode: CutMode, outputPath = 'D:/a.mp4'): JobRequest {
  return {
    input: {
      path: 'D:/in.mp4',
      dir: 'D:/',
      base: 'in',
      ext: '.mp4',
      sizeBytes: 1,
      durationSec: 10,
      formatName: 'mov,mp4',
      streams: [],
    },
    segments: [],
    mode,
    outputPath,
    suffix: '_cut',
    encoder: 'svtav1',
  }
}

/** 让所有挂起的微任务/宏任务跑完 */
function flush(n = 8): Promise<void> {
  let p: Promise<void> = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => undefined)
  return p
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('JobScheduler 队列调度', () => {
  it('copy 走前台，立即执行', async () => {
    let fgRuns = 0
    const sched = new JobScheduler({
      send: () => {},
      run: async () => {
        fgRuns++
      },
    })
    const r = sched.start(req('copy'))
    expect(r.lane).toBe('fg')
    await flush()
    expect(fgRuns).toBe(1)
  })

  it('compress 进后台队列，无前台时立即开始', async () => {
    const events: JobEvent[] = []
    const sched = new JobScheduler({
      send: (_j, e) => events.push(e),
      run: async (entry, emit) => {
        emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 1 })
      },
    })
    const r = sched.start(req('compress'))
    expect(r.lane).toBe('bg')
    await flush()
    const types = events.map((e) => e.type)
    expect(types).toContain('queued')
    expect(types).toContain('started')
    expect(types).toContain('done')
  })

  it('FIFO：两个压缩任务依次执行，不并发', async () => {
    const order: string[] = []
    const running = new Set<string>()
    const concurrency: number[] = []
    const sched = new JobScheduler({
      send: () => {},
      run: async (entry, emit) => {
        running.add(entry.outputPath)
        concurrency.push(running.size)
        await flush()
        order.push(entry.outputPath)
        running.delete(entry.outputPath)
        emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 1 })
      },
    })
    sched.start(req('compress', 'D:/a.mp4'))
    sched.start(req('compress', 'D:/b.mp4'))
    await flush(20)
    expect(order).toEqual(['D:/a.mp4', 'D:/b.mp4'])
    expect(Math.max(...concurrency)).toBe(1)
  })

  it('前台流复制抢占后台压缩：paused → 完成 → resumed', async () => {
    const events: JobEvent[] = []
    const bgStarted = deferred()
    const bgRelease = deferred()
    const sched = new JobScheduler({
      send: (_j, e) => events.push(e),
      run: async (entry, emit) => {
        if (entry.req.mode === 'compress') {
          bgStarted.resolve()
          await bgRelease.promise
          emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 5 })
        } else {
          emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 1 })
        }
      },
    })

    sched.start(req('compress', 'D:/a.mp4'))
    await bgStarted.promise

    const r = sched.start(req('copy', 'D:/b.mp4'))
    expect(r.lane).toBe('fg')
    await flush()
    const idxPaused = events.findIndex((e) => e.type === 'paused')
    expect(idxPaused).toBeGreaterThanOrEqual(0)

    bgRelease.resolve()
    await flush()
    const idxResumed = events.findIndex((e) => e.type === 'resumed')
    expect(idxResumed).toBeGreaterThan(idxPaused)
    expect(events.filter((e) => e.type === 'done').length).toBe(2)
  })

  it('前台已有任务时再发 copy 抛错', async () => {
    const first = deferred()
    const sched = new JobScheduler({
      send: () => {},
      run: async () => {
        await first.promise
      },
    })
    sched.start(req('copy', 'D:/a.mp4'))
    expect(() => sched.start(req('copy', 'D:/b.mp4'))).toThrow()
    first.resolve()
  })

  it('取消排队中的压缩任务（不启动它）', async () => {
    const events: JobEvent[] = []
    const first = deferred()
    const sched = new JobScheduler({
      send: (_j, e) => events.push(e),
      run: async (entry, emit) => {
        if (entry.outputPath === 'D:/a.mp4') {
          await first.promise
          emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 1 })
        } else {
          emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 1 })
        }
      },
    })

    sched.start(req('compress', 'D:/a.mp4'))
    await flush()
    sched.start(req('compress', 'D:/b.mp4'))
    sched.cancel('job-2') // 第二个 compress 的 jobId
    await flush()
    expect(events.filter((e) => e.type === 'canceled').length).toBe(1)

    first.resolve()
    await flush()
    // 第一个结束后，被取消的第二个不应再启动
    expect(events.filter((e) => e.type === 'started').length).toBe(1)
  })

  it('run 异常中断时发出 error 事件（避免渲染层 running 卡死）', async () => {
    const events: JobEvent[] = []
    const sched = new JobScheduler({
      send: (_j, e) => events.push(e),
      run: async () => {
        throw new Error('模拟失败')
      },
    })
    sched.start(req('copy', 'D:/a.mp4'))
    await flush()
    const error = events.find(
      (e): e is Extract<JobEvent, { type: 'error' }> => e.type === 'error'
    )
    expect(error?.message).toContain('模拟失败')
  })

  it('已存在于磁盘的路径不被调度器改名（尊重用户覆盖选择）', async () => {
    // 调度器只对「队列里已 claim」的路径去重，磁盘占用由渲染层 output:check
    // + 用户确认处理。这里用一个 100% 返回 false 的 isTaken 语义等价于无 claim：
    // 请求的路径应该原样保留，即使它"已存在"。
    const events: JobEvent[] = []
    const sched = new JobScheduler({
      send: (_j, e) => events.push(e),
      run: async (entry, emit) => {
        emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 1 })
      },
    })
    sched.start(req('compress', 'D:/a.mp4'))
    await flush()
    const queued = events.find((e): e is { type: 'queued'; outputPath: string } => e.type === 'queued')
    expect(queued?.outputPath).toBe('D:/a.mp4')
  })

  it('同一输出路径被队列抢占时自动改名 _2', async () => {
    const queuedPaths: string[] = []
    const sched = new JobScheduler({
      send: (_j, e) => {
        if (e.type === 'queued') queuedPaths.push(e.outputPath)
      },
      run: async (entry, emit) => {
        emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 1 })
      },
    })
    sched.start(req('compress', 'D:/a.mp4'))
    sched.start(req('compress', 'D:/a.mp4'))
    await flush()
    expect(queuedPaths).toEqual(['D:/a.mp4', 'D:/a_2.mp4'])
  })

  it('手动暂停运行中的压缩任务：paused → resume → 恢复 running', async () => {
    const events: JobEvent[] = []
    const started = deferred()
    const release = deferred()
    const sched = new JobScheduler({
      send: (_j, e) => events.push(e),
      run: async (entry, emit) => {
        if (entry.req.mode === 'compress') {
          started.resolve()
          await release.promise
          emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 5 })
        }
      },
    })

    const r = sched.start(req('compress', 'D:/a.mp4'))
    await started.promise

    sched.pause(r.jobId)
    await flush()
    const paused = events.find((e): e is Extract<JobEvent, { type: 'paused' }> => e.type === 'paused')
    expect(paused).toBeDefined()
    expect(paused?.reason).toBe('manual')

    sched.resume(r.jobId)
    await flush()
    expect(events.some((e) => e.type === 'resumed')).toBe(true)

    release.resolve()
    await flush()
    expect(events.filter((e) => e.type === 'done').length).toBe(1)
  })

  it('游戏激活时压缩任务自动降级；退出后恢复', async () => {
    const events: JobEvent[] = []
    const started = deferred()
    const release = deferred()
    const sched = new JobScheduler({
      send: (_j, e) => events.push(e),
      run: async (entry, emit) => {
        if (entry.req.mode === 'compress') {
          started.resolve()
          await release.promise
          emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 5 })
        }
      },
    })

    sched.start(req('compress', 'D:/a.mp4'))
    await started.promise

    sched.setGameActive(true)
    await flush()
    const paused = events.find((e): e is Extract<JobEvent, { type: 'paused' }> => e.type === 'paused')
    expect(paused?.reason).toBe('game')

    sched.setGameActive(false)
    await flush()
    expect(events.some((e) => e.type === 'resumed')).toBe(true)

    release.resolve()
    await flush()
    expect(events.filter((e) => e.type === 'done').length).toBe(1)
  })

  it('手动暂停叠加游戏激活：先恢复手动，游戏仍保持暂停；游戏退出才真正恢复', async () => {
    const events: JobEvent[] = []
    const started = deferred()
    const release = deferred()
    const sched = new JobScheduler({
      send: (_j, e) => events.push(e),
      run: async (entry, emit) => {
        if (entry.req.mode === 'compress') {
          started.resolve()
          await release.promise
          emit({ type: 'done', outputPath: entry.outputPath, elapsedSec: 5 })
        }
      },
    })

    const r = sched.start(req('compress', 'D:/a.mp4'))
    await started.promise

    sched.pause(r.jobId) // 手动暂停
    sched.setGameActive(true) // 再叠加游戏
    await flush()
    expect(events.filter((e) => e.type === 'paused').length).toBe(1)

    sched.resume(r.jobId) // 解除手动暂停
    await flush()
    // 游戏仍激活：任务应保持暂停，不出现 resumed
    expect(events.filter((e) => e.type === 'resumed').length).toBe(0)
    const pausedEvents = events.filter(
      (e): e is Extract<JobEvent, { type: 'paused' }> => e.type === 'paused'
    )
    expect(pausedEvents[pausedEvents.length - 1]?.reason).toBe('game')

    sched.setGameActive(false) // 游戏退出
    await flush()
    expect(events.filter((e) => e.type === 'resumed').length).toBe(1)

    release.resolve()
    await flush()
    expect(events.filter((e) => e.type === 'done').length).toBe(1)
  })
})
