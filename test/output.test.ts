import { describe, it, expect } from 'vitest'
import { resolveOutputPath } from '../src/shared/output'

describe('resolveOutputPath', () => {
  it('未被占用时原样返回', () => {
    expect(resolveOutputPath('D:/a.mp4', () => false)).toBe('D:/a.mp4')
  })

  it('磁盘已占用时取 base_2.ext', () => {
    expect(resolveOutputPath('D:/a.mp4', (p) => p === 'D:/a.mp4')).toBe('D:/a_2.mp4')
  })

  it('_2 也被占用时取 _3', () => {
    const taken = new Set(['D:/a.mp4', 'D:/a_2.mp4'])
    expect(resolveOutputPath('D:/a.mp4', (p) => taken.has(p))).toBe('D:/a_3.mp4')
  })

  it('无扩展名时在末尾追加 _2', () => {
    expect(resolveOutputPath('D:/a', (p) => p === 'D:/a')).toBe('D:/a_2')
  })

  it('目录里的点号不被误当作扩展名', () => {
    expect(resolveOutputPath('D:/v.2026/a.mp4', (p) => p === 'D:/v.2026/a.mp4')).toBe(
      'D:/v.2026/a_2.mp4'
    )
  })

  it('isTaken 同时判断磁盘与已 claim 的路径', () => {
    const claimed = new Set(['D:/a.mp4'])
    const diskTaken = (p: string) => p === 'D:/a_2.mp4'
    const isTaken = (p: string) => claimed.has(p) || diskTaken(p)
    // D:/a.mp4 被 claim、D:/a_2.mp4 已存在于磁盘 → 取 _3
    expect(resolveOutputPath('D:/a.mp4', isTaken)).toBe('D:/a_3.mp4')
  })
})
