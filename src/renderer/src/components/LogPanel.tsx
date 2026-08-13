import { useEffect, useRef, useState } from 'react'
import type { LogEntry } from '@shared/types'

/** 把一条日志渲染成可复制的纯文本行（展示与复制共用同一格式） */
function renderLogLine(l: LogEntry): string {
  const tag = l.level === 'error' ? 'ERROR' : l.level === 'warn' ? 'WARN ' : 'INFO '
  return `${l.ts} [${tag}] ${l.message}`
}

/**
 * 全局处理日志面板。
 *
 * 展示探测、吸附、切分、拼接的所有中间过程（来自主进程 log:event），
 * 支持一键复制全部、清空重来。
 */
export function LogPanel({ logs, onClear }: { logs: LogEntry[]; onClear: () => void }) {
  const [copied, setCopied] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // 新日志到达时自动滚到底部
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])

  const allText = logs.map(renderLogLine).join('\n')

  const copy = async () => {
    if (logs.length === 0) return
    await navigator.clipboard.writeText(allText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>
          处理日志（{logs.length} 行）
        </div>
        <div className="spacer" />
        <button onClick={() => void copy()} disabled={logs.length === 0}>
          {copied ? '已复制' : '复制全部'}
        </button>
        <button onClick={onClear} disabled={logs.length === 0}>
          清空
        </button>
      </div>
      <div className="log-box log-panel-box" ref={boxRef}>
        {logs.map((l, i) => (
          <div key={i} className={`log-line log-${l.level}`}>
            {renderLogLine(l)}
          </div>
        ))}
      </div>
    </div>
  )
}
