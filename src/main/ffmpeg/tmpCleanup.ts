/**
 * 临时中间产物的孤儿清理。
 *
 * 正常任务结束（成功/失败/取消）都会在 job.ts 的 finally 里删掉自己的临时目录，
 * 这里是兜底：软件被强杀、系统崩溃、或删除因权限问题失败时，`videocut-*` 目录
 * 会残留在系统临时目录里。不能完全依赖操作系统自己的临时文件回收——那个时机
 * 不可控，用户重装系统前可能几个月都不会清。
 *
 * tmpDir 作为参数注入而非直接读 os.tmpdir()，方便脱离真实系统临时目录单测。
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 每次任务的临时目录前缀，与 job.ts 的 makeTmpDir 共用同一个常量 */
export const TMP_DIR_PREFIX = 'videocut-'

export interface OrphanScanResult {
  /** 匹配到的目录完整路径 */
  dirs: string[]
  /** 目录内容总大小（字节），递归统计 */
  totalBytes: number
}

/** 递归统计目录大小；单个文件/子目录 stat 失败（如权限、竞态删除）时跳过，不中断整体统计 */
function dirSize(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      total += st.isDirectory() ? dirSize(p) : st.size
    } catch {
      // 跳过单个损坏项，不影响其余统计
    }
  }
  return total
}

/** 扫描 tmpDir 下所有以 TMP_DIR_PREFIX 为前缀的目录，汇总数量与总大小，不做任何删除 */
export function scanOrphanTmpDirs(tmpDir: string): OrphanScanResult {
  let entries: string[]
  try {
    entries = readdirSync(tmpDir)
  } catch {
    return { dirs: [], totalBytes: 0 }
  }

  const dirs = entries
    .filter((name) => name.startsWith(TMP_DIR_PREFIX))
    .map((name) => join(tmpDir, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })

  const totalBytes = dirs.reduce((sum, d) => sum + dirSize(d), 0)
  return { dirs, totalBytes }
}

/** 删除 tmpDir 下所有孤儿临时目录，返回释放的字节数。单个目录删除失败不影响其余目录。 */
export function cleanupOrphanTmpDirs(tmpDir: string): number {
  const { dirs } = scanOrphanTmpDirs(tmpDir)
  let freed = 0
  for (const dir of dirs) {
    const size = dirSize(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
      freed += size
    } catch {
      // 单个目录清理失败（权限等）不影响其余目录，留给下次启动再试
    }
  }
  return freed
}
