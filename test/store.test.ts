import { describe, it, expect } from 'vitest'
import { initialState, reducer } from '../src/renderer/src/store'

describe('store reducer：时间段编辑', () => {
  it('seg/edit 更新起点并同步解析 startSec', () => {
    const seg = initialState.segments[0]
    const next = reducer(initialState, {
      type: 'seg/edit',
      id: seg.id,
      field: 'startRaw',
      value: '00:01:00',
    })
    expect(next.segments[0].startRaw).toBe('00:01:00')
    expect(next.segments[0].startSec).toBe(60)
  })

  it('seg/edit 更新终点并清除该端的吸附值', () => {
    const seg = initialState.segments[0]
    const withSnap = reducer(initialState, {
      type: 'seg/applySnaps',
      ids: [seg.id],
      snaps: [{ startSec: 1, endSec: 2 }],
    })
    expect(withSnap.segments[0].snappedStartSec).toBe(1)

    const next = reducer(withSnap, {
      type: 'seg/edit',
      id: seg.id,
      field: 'endRaw',
      value: '00:02:00',
    })
    expect(next.segments[0].endRaw).toBe('00:02:00')
    expect(next.segments[0].snappedEndSec).toBeUndefined()
  })

  it('seg/remove 删除指定时间段', () => {
    const a = { ...initialState.segments[0], id: 'a', startRaw: '00:01:00' }
    const b = { ...initialState.segments[0], id: 'b', startRaw: '00:02:00' }
    const s = { ...initialState, segments: [a, b] }
    const next = reducer(s, { type: 'seg/remove', id: 'a' })
    expect(next.segments).toHaveLength(1)
    expect(next.segments[0].id).toBe('b')
  })

  it('删除最后一段后保留一个空行可继续编辑', () => {
    const s = { ...initialState, segments: [initialState.segments[0]] }
    const next = reducer(s, { type: 'seg/remove', id: s.segments[0].id })
    expect(next.segments).toHaveLength(1)
    expect(next.segments[0].startRaw).toBe('')
  })

  it('session/restored 恢复时间段、mode 与 suffix（起终点重新解析）', () => {
    const next = reducer(initialState, {
      type: 'session/restored',
      meta: {
        path: 'D:/in.mp4',
        dir: 'D:/',
        base: 'in',
        ext: '.mp4',
        sizeBytes: 1,
        durationSec: 600,
        formatName: 'mov,mp4',
        streams: [],
      },
      mediaUrl: 'media://local/D:/in.mp4',
      segments: [
        { startRaw: '00:01:00', endRaw: '00:02:00' },
        { startRaw: '00:03:00', endRaw: '00:04:00' },
      ],
      mode: 'compress',
      suffix: '_cut_compressed',
      encoder: 'amf',
    })
    expect(next.meta?.path).toBe('D:/in.mp4')
    expect(next.segments).toHaveLength(2)
    expect(next.segments[0].startSec).toBe(60)
    expect(next.segments[1].endSec).toBe(240)
    expect(next.mode).toBe('compress')
    expect(next.suffix).toBe('_cut_compressed')
    expect(next.encoder).toBe('amf')
    expect(next.job.jobId).toBeNull()
  })
})
