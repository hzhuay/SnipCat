import { describe, it, expect } from 'vitest'
import type { JobRequest, PersistedTask, TaskState } from '../src/shared/types'
import { TaskStore, type TaskStorage } from '../src/main/tasks'

function req(outputPath = 'D:/a.mp4'): JobRequest {
  return {
    input: {
      path: 'D:/in.mp4',
      dir: 'D:/',
      base: 'in',
      ext: '.mp4',
      sizeBytes: 1,
      durationSec: 600,
      formatName: 'mov,mp4',
      streams: [],
    },
    segments: [
      { id: 'seg-1', startRaw: '00:01:00', endRaw: '00:02:00', startSec: 60, endSec: 120 },
    ],
    mode: 'compress',
    outputPath,
    suffix: '_cut_compressed',
    encoder: 'svtav1',
  }
}

/** 造一个用内存存储的 TaskStore，能拿到持久化快照与广播记录 */
function makeStore() {
  let persisted: PersistedTask[] = []
  const broadcasts: TaskState[] = []
  const storage: TaskStorage = {
    loadTasks: () => persisted,
    saveTasks: (tasks) => {
      persisted = tasks
    },
  }
  const store = new TaskStore({ storage, broadcast: (t) => broadcasts.push(t) })
  return { store, storage, persisted: () => persisted, broadcasts }
}

describe('TaskStore 后台任务持久化', () => {
  it('enqueue 创建 queued 任务并广播 + 落盘（剥掉运行时字段）', () => {
    const { store, persisted, broadcasts } = makeStore()
    const t = store.enqueue('job-1', req())
    expect(t.id).toBe('t-1')
    expect(t.status).toBe('queued')
    expect(t.jobId).toBe('job-1')
    expect(t.segments[0]).toEqual({ startRaw: '00:01:00', endRaw: '00:02:00' })
    expect(broadcasts[0]).toBe(t)
    const saved = persisted()[0]
    expect(saved).not.toHaveProperty('ratio')
    expect(saved).not.toHaveProperty('jobId')
    expect(saved.segments).toEqual([{ startRaw: '00:01:00', endRaw: '00:02:00' }])
  })

  it('状态迁移：started→running / paused→paused / resumed→running / done→done', () => {
    const { store, persisted } = makeStore()
    store.enqueue('job-1', req())
    store.onJobEvent('job-1', { type: 'started' })
    expect(store.get('t-1')?.status).toBe('running')
    store.onJobEvent('job-1', { type: 'paused' })
    expect(store.get('t-1')?.status).toBe('paused')
    store.onJobEvent('job-1', { type: 'resumed' })
    expect(store.get('t-1')?.status).toBe('running')
    store.onJobEvent('job-1', { type: 'done', outputPath: 'D:/a.mp4', elapsedSec: 10 })
    expect(store.get('t-1')?.status).toBe('done')
    expect(store.get('t-1')?.jobId).toBeUndefined()
    expect(persisted()[0].status).toBe('done')
  })

  it('progress 只更新内存与广播，不落盘', () => {
    const { store, persisted, broadcasts } = makeStore()
    store.enqueue('job-1', req())
    store.onJobEvent('job-1', { type: 'started' })
    const savesAfterStart = broadcasts.length
    store.onJobEvent('job-1', { type: 'progress', ratio: 0.42, etaSec: 30 })
    expect(store.get('t-1')?.ratio).toBe(0.42)
    // 进度触发广播但不触发 saveTasks（persisted 引用未变）
    expect(broadcasts.length).toBeGreaterThan(savesAfterStart)
    expect(persisted()).toHaveLength(1)
    expect(persisted()[0].status).toBe('running') // 仍是 started 时的落盘状态
  })

  it('error 记录 message，canceled 置状态', () => {
    const { store } = makeStore()
    store.enqueue('job-1', req())
    store.onJobEvent('job-1', { type: 'error', message: 'ffmpeg 退出码 1', stderrTail: [] })
    expect(store.get('t-1')?.status).toBe('error')
    expect(store.get('t-1')?.error).toBe('ffmpeg 退出码 1')

    store.enqueue('job-2', req('D:/b.mp4'))
    store.onJobEvent('job-2', { type: 'canceled' })
    expect(store.get('t-2')?.status).toBe('canceled')
  })

  it('hasActiveDuplicate：同源同后缀且未终态时返回 true，完成后不再算重复', () => {
    const { store } = makeStore()
    store.enqueue('job-1', req('D:/a.mp4'))
    // 另一个请求只是输出路径不同，inputPath 与 suffix 相同 → 判为重复
    expect(store.hasActiveDuplicate(req('D:/b.mp4'))).toBe(true)

    store.onJobEvent('job-1', { type: 'done', outputPath: 'D:/a.mp4', elapsedSec: 1 })
    expect(store.hasActiveDuplicate(req('D:/b.mp4'))).toBe(false)
  })

  it('resume 复用原 id 并重置为 queued', () => {
    const { store } = makeStore()
    store.enqueue('job-1', req())
    const resumed = store.resume('t-1', 'job-2', req('D:/b.mp4'))
    expect(resumed.id).toBe('t-1')
    expect(resumed.status).toBe('queued')
    expect(resumed.jobId).toBe('job-2')
    expect(resumed.outputPath).toBe('D:/b.mp4')
  })

  it('markInterrupted 只标非终态，done 保留', () => {
    const { store, persisted } = makeStore()
    store.enqueue('job-1', req('D:/a.mp4')) // queued
    store.enqueue('job-2', req('D:/b.mp4'))
    store.onJobEvent('job-2', { type: 'done', outputPath: 'D:/b.mp4', elapsedSec: 5 })
    store.enqueue('job-3', req('D:/c.mp4'))
    store.onJobEvent('job-3', { type: 'started' })

    store.markInterrupted()
    expect(store.get('t-1')?.status).toBe('interrupted')
    expect(store.get('t-2')?.status).toBe('done')
    expect(store.get('t-3')?.status).toBe('interrupted')
    expect(store.get('t-3')?.jobId).toBeUndefined()
    expect(persisted().map((t) => t.status)).toEqual(['interrupted', 'done', 'interrupted'])
  })

  it('delete 移除任务并落盘', () => {
    const { store, persisted } = makeStore()
    store.enqueue('job-1', req())
    store.enqueue('job-2', req('D:/b.mp4'))
    store.delete('t-1')
    expect(store.list().map((t) => t.id)).toEqual(['t-2'])
    expect(persisted().map((t) => t.id)).toEqual(['t-2'])
  })

  it('load 读入持久化任务，id 续号不冲突', () => {
    const { store, storage } = makeStore()
    storage.saveTasks([
      {
        id: 't-5',
        inputPath: 'D:/in.mp4',
        segments: [{ startRaw: '00:01:00', endRaw: '00:02:00' }],
        mode: 'compress',
        suffix: '_cut_compressed',
        encoder: 'svtav1',
        outputPath: 'D:/a.mp4',
        createdAt: 1,
        status: 'interrupted',
      },
    ])
    store.load()
    expect(store.get('t-5')?.status).toBe('interrupted')
    const t = store.enqueue('job-new', req())
    expect(t.id).toBe('t-6') // 续号，不冲突
  })
})
