import { useState } from 'react'
import type { PlannedCommand } from '../../../preload'

/**
 * Dry-run 命令面板。
 *
 * 展示的命令来自与真实执行完全相同的 buildJobCommands 调用，
 * 所以「显示的命令」就是「实际会跑的命令」。
 */
export function CommandPanel({
  commands,
  onClose,
}: {
  commands: PlannedCommand[]
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  const allText = commands.map((c) => `# ${c.label}\n${c.line}`).join('\n\n')

  const copy = async () => {
    await navigator.clipboard.writeText(allText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>
          将要执行的命令（{commands.length} 条）
        </div>
        <div className="spacer" />
        <button onClick={copy}>{copied ? '已复制' : '复制全部'}</button>
        <button className="icon" onClick={onClose}>
          ✕
        </button>
      </div>

      {commands.map((c, i) => (
        <div className="cmd-item" key={i}>
          <div className="cmd-label">{c.label}</div>
          <div className="log-box">{c.line}</div>
        </div>
      ))}

      <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
        临时目录为占位路径，实际执行时会创建带随机后缀的目录并在结束后清理。
      </div>
    </div>
  )
}
