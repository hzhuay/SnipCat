/**
 * userData 目录下的 JSON 持久化。
 *
 * 写盘用「先写 .tmp 再 rename」的原子方式：即使写一半崩溃也不会损坏已有文件。
 * 只能在 app ready 之后调用（app.getPath('userData') 需要初始化完成）。
 */

import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function filePath(name: string): string {
  return join(app.getPath('userData'), name)
}

/** 读 JSON，文件缺失或损坏时返回 fallback */
export function loadJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

/** 原子写 JSON */
export function saveJson(name: string, data: unknown): void {
  const target = filePath(name)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, target)
}
