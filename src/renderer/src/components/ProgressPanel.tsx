import type { JobState } from '../store'
import { formatCompact } from '@shared/time'

const STAGE_TEXT: Record<string, string> = {
  probe: '读取元数据…',
  keyframe: '探测关键帧位置…',
  cut: '切分中',
  concat: '拼接中…',
  finalize: '写入输出文件…',
}

/** 进度、日志、完成/失败状态 */
export function ProgressPanel({
  job,
  onCancel,
  onReset,
  onReveal,
}: {
  job: JobState
  onCancel: () => void
  onReset: () => void
  onReveal: (path: string) => void
}) {
  const running = job.jobId !== null && !job.result && !job.error && !job.canceled

  return (
    <div className="panel">
      {running && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <span>
              {STAGE_TEXT[job.stage ?? ''] ?? '准备中…'}
              {job.stage === 'cut' && job.stageIndex
                ? ` 第 ${job.stageIndex}/${job.stageTotal} 段…`
                : ''}
            </span>
            <div className="spacer" />
            <span className="dim mono">{Math.round(job.ratio * 100)}%</span>
            {job.etaSec !== undefined && (
              <span className="dim">剩余约 {formatCompact(job.etaSec)}</span>
            )}
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${job.ratio * 100}%` }} />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <div className="spacer" />
            <button className="danger" onClick={onCancel}>
              取消
            </button>
          </div>
        </>
      )}

      {job.result && (
        <div className="row">
          <span className="status-done">
            ✓ 已输出 {job.result.outputPath.split('/').pop()}
          </span>
          <span className="dim">（{job.result.elapsedSec.toFixed(1)} 秒）</span>
          <div className="spacer" />
          <button onClick={() => onReveal(job.result!.outputPath)}>在文件管理器中显示</button>
          <button onClick={onReset}>再来一次</button>
        </div>
      )}

      {job.error && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="status-error">✗ 处理失败</span>
            <span className="dim">{job.error.message}</span>
            <div className="spacer" />
            <button onClick={onReset}>关闭</button>
          </div>
          {job.error.stderrTail.length > 0 && (
            <div className="log-box error-log">{job.error.stderrTail.join('\n')}</div>
          )}
        </>
      )}

      {job.canceled && (
        <div className="row">
          <span className="dim">已取消，未生成输出文件</span>
          <div className="spacer" />
          <button onClick={onReset}>关闭</button>
        </div>
      )}

      {job.logs.length > 0 && (running || job.error) && (
        <details style={{ marginTop: 12 }}>
          <summary>ffmpeg 日志（{job.logs.length} 行）</summary>
          <div className="log-box">{job.logs.slice(-80).join('\n')}</div>
        </details>
      )}
    </div>
  )
}
