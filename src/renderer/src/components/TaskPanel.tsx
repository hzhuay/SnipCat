import { useCallback, useEffect, useState } from 'react'
import type { CacheUsage, TaskState } from '@shared/types'
import { formatCompact } from '@shared/time'
import { formatBytes } from '@shared/probe'

const STATUS_TEXT: Record<TaskState['status'], string> = {
  queued: '排队中',
  running: '处理中',
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

/** 是否还有可清除的已结束任务（done/error/canceled） */
function hasFinished(tasks: TaskState[]): boolean {
  return tasks.some((t) => t.status === 'done' || t.status === 'error' || t.status === 'canceled')
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
 * 任务列表面板（放在「任务列表」菜单视图）。
 *
 * 流复制和压缩任务都在这：本次会话的实时进度 + 历史任务。支持取消、完成后
 * 显示文件、用保存的配置重新运行、载入编辑器微调、删除原视频、清除已完成。
 */
export function TaskPanel({
  tasks,
  onCancel,
  onReveal,
  onResume,
  onLoad,
  onDelete,
  onDeleteSource,
  onClearFinished,
}: {
  tasks: TaskState[]
  onCancel: (jobId: string) => void
  onReveal: (outputPath: string) => void
  onResume: (taskId: string) => void
  onLoad: (taskId: string) => void
  onDelete: (taskId: string) => void
  onDeleteSource: (taskId: string) => void
  onClearFinished: () => void
}) {
  if (tasks.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">任务列表</div>
        <CacheBar />
        <div className="dim" style={{ padding: '8px 0' }}>
          还没有任务。选好时间段后点「开始处理」，流复制和压缩任务都会在这里显示；
          压缩任务在后台排队执行，关闭软件后任务保留，可重新运行或删除源视频。
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>
          任务列表（{tasks.length}）
        </div>
        <div className="spacer" />
        <button onClick={onClearFinished} disabled={!hasFinished(tasks)}>
          清除已完成
        </button>
      </div>

      <CacheBar />

      {tasks.map((t) => {
        const sourceGone = Boolean(t.sourceDeleted)
        return (
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
              {t.status === 'done' &&
                (sourceGone ? (
                  <span className="dim" title="源视频已删除">
                    源已删除
                  </span>
                ) : (
                  <button onClick={() => handleDeleteSource(t, onDeleteSource)}>删除原视频</button>
                ))}
              {!cancellable(t) && !sourceGone && (
                <button onClick={() => onResume(t.id)}>重新运行</button>
              )}
              {!sourceGone && (
                <button onClick={() => onLoad(t.id)} title="把该任务的时间段载入编辑器微调">
                  载入编辑
                </button>
              )}
              <button className="icon" onClick={() => onDelete(t.id)} title="删除任务记录">
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
        )
      })}
    </div>
  )
}

/** 删除原视频前弹确认框（输出不受影响，不可恢复） */
function handleDeleteSource(
  t: TaskState,
  onDeleteSource: (taskId: string) => void
): void {
  const ok = window.confirm(
    `确认删除原视频？\n\n${t.inputPath}\n\n输出文件不受影响，此操作不可恢复。`
  )
  if (ok) onDeleteSource(t.id)
}
