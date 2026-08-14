import { useCallback, useEffect, useState } from 'react'
import type { CacheUsage, TaskState } from '@shared/types'
import { formatCompact } from '@shared/time'
import { formatBytes } from '@shared/probe'

const STATUS_TEXT: Record<TaskState['status'], string> = {
  queued: '排队中',
  running: '压缩中',
  paused: '已暂停',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
  interrupted: '已中断',
}

function filenameOf(p: string): string {
  return p.split('/').pop() || p
}

/** 可取消的任务（本次会话正在跑的） */
function cancellable(t: TaskState): boolean {
  return Boolean(t.jobId) && (t.status === 'queued' || t.status === 'running' || t.status === 'paused')
}

/**
 * 缓存清理条：展示系统临时目录下残留的中间产物占用（正常任务结束会自动清，
 * 这里给用户一个可见的兜底手段），支持一键清理。
 */
function CacheBar() {
  const [usage, setUsage] = useState<CacheUsage | null>(null)
  const [clearing, setClearing] = useState(false)

  const refresh = useCallback(() => {
    void window.api.getCacheUsage().then(setUsage)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleClear = useCallback(async () => {
    setClearing(true)
    try {
      await window.api.clearCache()
    } finally {
      setClearing(false)
      refresh()
    }
  }, [refresh])

  if (!usage || usage.dirCount === 0) {
    return (
      <div className="row cache-bar dim" style={{ marginBottom: 10 }}>
        <span>缓存占用：0 B（无残留临时文件）</span>
      </div>
    )
  }

  return (
    <div className="row cache-bar" style={{ marginBottom: 10 }}>
      <span className="dim">
        缓存占用：{formatBytes(usage.bytes)}（{usage.dirCount} 个残留临时目录）
      </span>
      <div className="spacer" />
      <button onClick={() => void handleClear()} disabled={clearing}>
        {clearing ? '清理中…' : '清理缓存'}
      </button>
    </div>
  )
}

/**
 * 后台压缩任务面板（放在「后台任务」菜单视图）。
 *
 * 展示持久化的压缩任务：本次会话的实时进度 + 历史/已中断任务。支持取消、
 * 完成后显示文件、用保存的配置重新运行、载入编辑器微调、删除。
 */
export function TaskPanel({
  tasks,
  onCancel,
  onReveal,
  onResume,
  onLoad,
  onDelete,
}: {
  tasks: TaskState[]
  onCancel: (jobId: string) => void
  onReveal: (outputPath: string) => void
  onResume: (taskId: string) => void
  onLoad: (taskId: string) => void
  onDelete: (taskId: string) => void
}) {
  if (tasks.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">后台任务</div>
        <CacheBar />
        <div className="dim" style={{ padding: '8px 0' }}>
          还没有压缩任务。选好时间段后切换「压缩」模式并点「开始处理」，任务会在这里排队执行；
          中途关闭软件后任务保留，可一键重新运行。
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>
          后台任务（{tasks.length}）
        </div>
        <div className="spacer" />
        <span className="dim">重新运行会保留时间段配置，从起点重新压缩</span>
      </div>

      <CacheBar />

      {tasks.map((t) => (
        <div className="queue-item" key={t.id}>
          <div className="row">
            <span className={`queue-status queue-${t.status}`}>{STATUS_TEXT[t.status]}</span>
            <span className="mono queue-name" title={t.outputPath}>
              {filenameOf(t.outputPath)}
            </span>
            <div className="spacer" />
            {t.status === 'running' && t.etaSec !== undefined && (
              <span className="dim">剩余约 {formatCompact(t.etaSec)}</span>
            )}
            {t.status === 'paused' && <span className="dim">前台处理中，完成后自动继续</span>}
            {t.status === 'interrupted' && (
              <span className="dim">上次被中断（{Math.round(t.ratio * 100)}%）</span>
            )}
            {cancellable(t) && <button onClick={() => t.jobId && onCancel(t.jobId)}>取消</button>}
            {t.status === 'done' && <button onClick={() => onReveal(t.outputPath)}>显示</button>}
            {!cancellable(t) && <button onClick={() => onResume(t.id)}>重新运行</button>}
            <button onClick={() => onLoad(t.id)} title="把该任务的时间段载入编辑器微调">
              载入编辑
            </button>
            <button className="icon" onClick={() => onDelete(t.id)} title="删除任务">
              ✕
            </button>
          </div>

          <div className="dim queue-meta">
            {filenameOf(t.inputPath)} · {t.segments.length} 段 ·{' '}
            {t.mode === 'copy' ? '流复制' : '压缩'}
          </div>

          {(t.status === 'running' || t.status === 'paused') && (
            <div className="progress-track" style={{ marginTop: 6 }}>
              <div className="progress-fill" style={{ width: `${t.ratio * 100}%` }} />
            </div>
          )}

          {t.status === 'error' && t.error && (
            <div className="seg-note error">✗ {t.error}</div>
          )}
        </div>
      ))}
    </div>
  )
}
