/**
 * 主进程日志。
 *
 * 所有处理步骤（探测元数据、切点吸附、切分、拼接、环境检查）都通过这里发日志，
 * 由 ipc 层注册的 sink 统一广播到渲染进程的日志面板 —— 单一来源，复制日志时
 * 不会漏掉中间过程。
 *
 * 刻意不依赖 Electron 的 webContents：logger 只是收集点，转发职责在 ipc.ts，
 * 保持这个文件纯主进程、可单测。
 */

import type { LogEntry, LogLevel } from '@shared/types'

type Sink = (entry: LogEntry) => void

let sink: Sink | null = null

/** 注册日志出口。ipc.ts 在启动时调用一次，把日志转发给渲染进程。 */
export function setLogSink(fn: Sink): void {
  sink = fn
}

/** 本地时间 HH:MM:SS.mmm */
function timestamp(): string {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

export function log(level: LogLevel, message: string): void {
  if (!sink) return
  sink({ ts: timestamp(), level, message })
}

export const logInfo = (message: string): void => log('info', message)
export const logWarn = (message: string): void => log('warn', message)
export const logError = (message: string): void => log('error', message)
