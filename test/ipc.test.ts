import { describe, it, expect } from 'vitest'
import { toIpcError } from '../src/main/ipc'
import { FFmpegError } from '../src/main/ffmpeg/runner'

describe('toIpcError', () => {
  it('FFmpegError 保留 stderrTail', () => {
    const err = new FFmpegError('ffmpeg 退出码 1', ['line1', 'line2'])
    const r = toIpcError(err)
    expect(r).toEqual({ name: 'FFmpegError', message: 'ffmpeg 退出码 1', stderrTail: ['line1', 'line2'] })
  })

  it('普通 Error 不带 stderrTail', () => {
    const r = toIpcError(new Error('出错了'))
    expect(r).toEqual({ name: 'Error', message: '出错了' })
    expect(r).not.toHaveProperty('stderrTail')
  })

  it('非 Error 值兜底为字符串化的 message，不抛异常', () => {
    expect(toIpcError('纯字符串错误')).toEqual({ name: 'Error', message: '纯字符串错误' })
    expect(toIpcError(undefined)).toEqual({ name: 'Error', message: 'undefined' })
    expect(toIpcError({ foo: 'bar' })).toEqual({ name: 'Error', message: '[object Object]' })
  })
})
