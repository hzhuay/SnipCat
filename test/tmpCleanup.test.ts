import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanOrphanTmpDirs, cleanupOrphanTmpDirs, TMP_DIR_PREFIX } from '../src/main/ffmpeg/tmpCleanup'

let root: string

beforeEach(() => {
  // 用独立根目录隔离，避免真实系统临时目录的其它文件干扰断言
  root = mkdtempSync(join(tmpdir(), 'tmpcleanup-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeOrphan(name: string, files: Record<string, string>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content, 'utf8')
  }
  return dir
}

describe('scanOrphanTmpDirs', () => {
  it('扫到所有 videocut- 前缀目录并汇总大小', () => {
    makeOrphan(`${TMP_DIR_PREFIX}a`, { 'x.mp4': 'a'.repeat(10) })
    makeOrphan(`${TMP_DIR_PREFIX}b`, { 'y.mp4': 'b'.repeat(20) })

    const r = scanOrphanTmpDirs(root)
    expect(r.dirs).toHaveLength(2)
    expect(r.totalBytes).toBe(30)
  })

  it('不匹配前缀的目录不会被扫到', () => {
    makeOrphan(`${TMP_DIR_PREFIX}a`, { 'x.mp4': 'a'.repeat(5) })
    makeOrphan('other-app-tmp', { 'y.mp4': 'b'.repeat(100) })

    const r = scanOrphanTmpDirs(root)
    expect(r.dirs).toHaveLength(1)
    expect(r.totalBytes).toBe(5)
  })

  it('空目录返回空结果，不报错', () => {
    const r = scanOrphanTmpDirs(root)
    expect(r.dirs).toEqual([])
    expect(r.totalBytes).toBe(0)
  })

  it('目录不存在时返回空结果，不抛异常', () => {
    const r = scanOrphanTmpDirs(join(root, '不存在的路径'))
    expect(r.dirs).toEqual([])
    expect(r.totalBytes).toBe(0)
  })

  it('递归统计嵌套子目录的大小', () => {
    const dir = makeOrphan(`${TMP_DIR_PREFIX}nested`, { 'a.txt': 'x'.repeat(3) })
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'b.txt'), 'y'.repeat(7), 'utf8')

    const r = scanOrphanTmpDirs(root)
    expect(r.totalBytes).toBe(10)
  })
})

describe('cleanupOrphanTmpDirs', () => {
  it('删除所有匹配目录并返回释放的字节数', () => {
    const a = makeOrphan(`${TMP_DIR_PREFIX}a`, { 'x.mp4': 'a'.repeat(10) })
    const b = makeOrphan(`${TMP_DIR_PREFIX}b`, { 'y.mp4': 'b'.repeat(15) })

    const freed = cleanupOrphanTmpDirs(root)

    expect(freed).toBe(25)
    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(false)
  })

  it('不匹配前缀的目录不会被删除', () => {
    const kept = makeOrphan('other-app-tmp', { 'z.mp4': 'z'.repeat(5) })
    makeOrphan(`${TMP_DIR_PREFIX}a`, { 'x.mp4': 'a'.repeat(5) })

    cleanupOrphanTmpDirs(root)

    expect(existsSync(kept)).toBe(true)
  })

  it('空目录调用不报错，返回 0', () => {
    expect(cleanupOrphanTmpDirs(root)).toBe(0)
  })
})
