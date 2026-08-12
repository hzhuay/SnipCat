import { useState } from 'react'
import type { CutMode, Segment, SegmentIssue, VideoMeta } from '@shared/types'
import { formatCompact, formatTime, parseTime } from '@shared/time'
import { snapDisplay } from '@shared/interaction'
import { frameDuration } from '@shared/video'

interface Props {
  meta: VideoMeta
  segments: Segment[]
  issues: SegmentIssue[]
  mode: CutMode
  totalDurationSec: number
  disabled: boolean
  /** 能否播放（无预览器时隐藏播放按钮） */
  canPlay: boolean
  onAdd: () => void
  onRemove: (id: string) => void
  onEdit: (id: string, field: 'startRaw' | 'endRaw', value: string) => void
  onNormalize: (id: string, field: 'startRaw' | 'endRaw', value: string) => void
  onMove: (from: number, to: number) => void
  onSort: () => void
  /** 从该段起点开始播放 */
  onPlaySegment: (startSec: number) => void
}

export function SegmentList(props: Props) {
  const { meta, segments, issues, mode, totalDurationSec, disabled } = props
  const frameDurationSec = frameDuration(meta)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>
          时间段
        </div>
        <div className="spacer" />
        <button className="icon" onClick={props.onSort} disabled={disabled} title="按起点时间排序">
          按时间排序
        </button>
      </div>

      <div className="seg-list">
        {segments.map((seg, i) => (
          <SegmentRow
            key={seg.id}
            index={i}
            seg={seg}
            mode={mode}
            issues={issues.filter((it) => it.segmentId === seg.id)}
            disabled={disabled}
            frameDurationSec={frameDurationSec}
            canPlay={props.canPlay}
            isDragging={dragIndex === i}
            isDropTarget={overIndex === i && dragIndex !== null && dragIndex !== i}
            onDragStart={() => setDragIndex(i)}
            onDragEnter={() => setOverIndex(i)}
            onDragEnd={() => {
              if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
                props.onMove(dragIndex, overIndex)
              }
              setDragIndex(null)
              setOverIndex(null)
            }}
            onRemove={() => props.onRemove(seg.id)}
            onEdit={(field, value) => props.onEdit(seg.id, field, value)}
            onNormalize={(field, value) => props.onNormalize(seg.id, field, value)}
            onPlay={() => {
              // 播放用户输入的起点，不是吸附后的 —— 用户想看的是自己标的位置
              if (seg.startSec !== null) props.onPlaySegment(seg.startSec)
            }}
          />
        ))}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={props.onAdd} disabled={disabled}>
          + 添加时间段
        </button>
        <div className="spacer" />
        <span className="dim">
          共 {countValid(segments)} 段 / {formatCompact(totalDurationSec)}
        </span>
      </div>
    </div>
  )
}

function countValid(segments: Segment[]): number {
  return segments.filter(
    (s) => s.startSec !== null && s.endSec !== null && s.endSec > s.startSec
  ).length
}

interface RowProps {
  index: number
  seg: Segment
  mode: CutMode
  issues: SegmentIssue[]
  disabled: boolean
  frameDurationSec: number
  canPlay: boolean
  isDragging: boolean
  isDropTarget: boolean
  onDragStart: () => void
  onDragEnter: () => void
  onDragEnd: () => void
  onRemove: () => void
  onEdit: (field: 'startRaw' | 'endRaw', value: string) => void
  onNormalize: (field: 'startRaw' | 'endRaw', value: string) => void
  onPlay: () => void
}

function SegmentRow(p: RowProps) {
  const { seg, issues } = p
  const error = issues.find((i) => i.level === 'error')
  const warning = issues.find((i) => i.level === 'warning')

  const startInvalid = seg.startRaw.trim() !== '' && seg.startSec === null
  const endInvalid = seg.endRaw.trim() !== '' && seg.endSec === null

  const duration =
    seg.startSec !== null && seg.endSec !== null && seg.endSec > seg.startSec
      ? seg.endSec - seg.startSec
      : null

  /**
   * 失焦时把输入规范化为 HH:MM:SS.mmm。
   * 只在能解析且与当前显示不同时才改写，避免打字过程中光标被打断。
   */
  const normalize = (field: 'startRaw' | 'endRaw', raw: string) => {
    const sec = parseTime(raw)
    if (sec === null) return
    const formatted = formatTime(sec)
    if (formatted !== raw) p.onNormalize(field, formatted)
  }

  const cls = [
    'seg-row',
    p.isDragging ? 'dragging' : '',
    p.isDropTarget ? 'drop-target' : '',
    error ? 'has-error' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cls}
      draggable={!p.disabled}
      onDragStart={p.onDragStart}
      onDragEnter={p.onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={p.onDragEnd}
    >
      <div className="row">
        <span className="seg-handle" title="拖拽调整顺序">
          ⠿
        </span>
        <span className="seg-index">{p.index + 1}</span>
        {p.canPlay && (
          <button
            className="icon seg-play"
            onClick={p.onPlay}
            disabled={seg.startSec === null}
            title="从该段起点开始播放"
          >
            ▶
          </button>
        )}
        <input
          type="text"
          className={`seg-input mono${startInvalid ? ' invalid' : ''}`}
          value={seg.startRaw}
          placeholder="00:00:00"
          disabled={p.disabled}
          onChange={(e) => p.onEdit('startRaw', e.target.value)}
          onBlur={(e) => normalize('startRaw', e.target.value)}
        />
        <span className="seg-arrow">→</span>
        <input
          type="text"
          className={`seg-input mono${endInvalid ? ' invalid' : ''}`}
          value={seg.endRaw}
          placeholder="00:00:00"
          disabled={p.disabled}
          onChange={(e) => p.onEdit('endRaw', e.target.value)}
          onBlur={(e) => normalize('endRaw', e.target.value)}
        />
        <span className="seg-dur">{duration !== null ? formatCompact(duration) : ''}</span>
        <div className="spacer" />
        <button className="icon" onClick={p.onRemove} disabled={p.disabled} title="删除">
          ✕
        </button>
      </div>

      {error ? (
        <div className="seg-note error">✗ {error.message}</div>
      ) : (
        <SnapNote
          seg={seg}
          mode={p.mode}
          frameDurationSec={p.frameDurationSec}
          warning={warning?.message}
        />
      )}
    </div>
  )
}

/**
 * 显示吸附后的实际切点与多切量。
 *
 * 这是本工具对「参数无损」与「切点精确」矛盾的处理方式：切点偏移是编码原理决定
 * 的物理限制（P/B 帧依赖前面的关键帧），无法优化掉，所以显式展示而不是静默发生。
 *
 * 两端一视同仁：起点向前吸附到关键帧、终点向后吸附到帧边界，都是向外扩，所以
 * 偏移是"多出来的部分"而非"丢掉的部分" —— 文案用「多切」而不是「偏移」。
 *
 * 显示值的取整方向见 snapDisplay 的注释：向内取整以保证幂等，否则把显示值输回
 * 输入框会让吸附结果再往外跳一格。
 */
function SnapNote({
  seg,
  mode,
  frameDurationSec,
  warning,
}: {
  seg: Segment
  mode: CutMode
  frameDurationSec: number
  warning?: string
}) {
  const snap = mode === 'copy' ? snapDisplay(seg, frameDurationSec) : null

  if (!snap && !warning) return null

  return (
    <div className={`seg-note ${warning || snap?.drifted ? 'warning' : 'ok'}`}>
      {snap && (
        <span style={{ marginRight: 12 }}>
          实际{' '}
          <span className="snap-actual">
            {formatTime(snap.startSec)} → {formatTime(snap.endSec)}
          </span>
        </span>
      )}
      {snap?.drifted && (
        <span className="snap-offset" style={{ marginRight: 12 }}>
          多切{' '}
          {[
            snap.headExtra > frameDurationSec / 2 ? `头 +${snap.headExtra.toFixed(2)}s` : null,
            snap.tailExtra > frameDurationSec / 2 ? `尾 +${snap.tailExtra.toFixed(2)}s` : null,
          ]
            .filter(Boolean)
            .join(' / ')}
        </span>
      )}
      {snap && !snap.drifted && <span style={{ marginRight: 12 }}>✓</span>}
      {warning && <span>⚠︎ {warning}</span>}
    </div>
  )
}
