import { describe, it, expect } from 'vitest'
import type { CutMode, JobRequest, PersistedTask, TaskState } from '../src/shared/types'
import { TaskStore, type TaskStorage } from '../src/main/tasks'

function req(outputPath = 'D:/a.mp4', mode: CutMode = 'compress'): JobRequest {
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
    mode,
    outputPath,
    suffix: mode === 'copy' ? '_cut' : '_cut_compressed',
    encoder: 'svtav1',
  }
}

/** 造一个用内存存储的 TaskStore，能拿到持久化快照、广播记录与删除记录 */
function makeStore() {
  let persisted: PersistedTask[] = []
  const broadcasts: TaskState[] = []
  const deletedPaths: string[] = []
  const storage: TaskStorage = {
    loadTasks: () => persisted,
    saveTasks: (tasks) => {
      persisted = tasks
    },
  }
  const store = new TaskStore({
    storage,
    broadcast: (t) => broadcasts.push(t),
    deleteFile: async (p) => {
      deletedPaths.push(p)
    },
  })
  return { store, storage, persisted: () => persisted, broadcasts, deletedPaths }
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

  it('流复制任务同样入列表并持久化（mode=copy）', () => {
    const { store, persisted } = makeStore()
    const t = store.enqueue('job-1', req('D:/a.mp4', 'copy'))
    expect(t.mode).toBe('copy')
    expect(store.get('t-1')?.status).toBe('queued')
    expect(persisted()[0].mode).toBe('copy')
  })

  it('deleteSource 只允许 done，删后标记 sourceDeleted 并落盘广播', async () => {
    const { store, deletedPaths, persisted, broadcasts } = makeStore()
    store.enqueue('job-1', req())
    store.onJobEvent('job-1', { type: 'done', outputPath: 'D:/a.mp4', elapsedSec: 1 })
    const before = broadcasts.length
    await store.deleteSource('t-1')
    expect(deletedPaths).toEqual(['D:/in.mp4']) // 删的是源视频，不是输出
    expect(store.get('t-1')?.sourceDeleted).toBe(true)
    expect(broadcasts.length).toBe(before + 1)
    expect(persisted()[0].sourceDeleted).toBe(true)
  })

  it('deleteSource 拒绝非 done 状态，且不删文件', async () => {
    const { store, deletedPaths } = makeStore()
    store.enqueue('job-1', req())
    await expect(store.deleteSource('t-1')).rejects.toThrow('已完成')
    expect(deletedPaths).toHaveLength(0)
  })

  it('deleteSource 重复调用报错（源已删除）', async () => {
    const { store, deletedPaths } = makeStore()
    store.enqueue('job-1', req())
    store.onJobEvent('job-1', { type: 'done', outputPath: 'D:/a.mp4', elapsedSec: 1 })
    await store.deleteSource('t-1')
    await expect(store.deleteSource('t-1')).rejects.toThrow('原视频已删除')
    expect(deletedPaths).toHaveLength(1) // 第二次不重复删
  })

  it('clearFinished 清除 done/error/canceled，保留 running 与 interrupted 并落盘', () => {
    const { store, persisted } = makeStore()
    store.enqueue('job-1', req('D:/a.mp4')) // done
    store.onJobEvent('job-1', { type: 'done', outputPath: 'D:/a.mp4', elapsedSec: 1 })
    store.enqueue('job-2', req('D:/b.mp4')) // running（后转 interrupted）
    store.onJobEvent('job-2', { type: 'started' })
    store.enqueue('job-3', req('D:/c.mp4')) // canceled
    store.onJobEvent('job-3', { type: 'canceled' })
    store.enqueue('job-4', req('D:/d.mp4')) // running → interrupted
    store.onJobEvent('job-4', { type: 'started' })
    store.markInterrupted()

    const rest = store.clearFinished()
    // 列表是 unshift 存的（最新在前），t-4 最新
    expect(rest.map((t) => t.id)).toEqual(['t-4', 't-2'])
    expect(store.get('t-2')?.status).toBe('interrupted')
    expect(persisted().map((t) => t.id)).toEqual(['t-4', 't-2'])
  })

  it('clearFinished 无可清任务时不变更存储', () => {
    const { store, persisted } = makeStore()
    store.enqueue('job-1', req('D:/a.mp4'))
    store.onJobEvent('job-1', { type: 'started' })
    const before = persisted()
    store.clearFinished()
    expect(store.list().map((t) => t.id)).toEqual(['t-1'])
    expect(persisted()).toBe(before) // 引用未变，未触发 saveTasks
  })
})
