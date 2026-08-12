import { useCallback, useEffect, useRef, useState } from 'react'
import type { Segment } from '@shared/types'
import { formatTime } from '@shared/time'

/** 时间轴上的拖拽目标 */
export type DragTarget =
  | { kind: 'playhead' }
  | { kind: 'handle'; segmentId: string; edge: 'start' | 'end' }

/** 手柄的命中半径（像素） */
const HANDLE_HIT_PX = 7

interface Props {
  durationSec: number
  currentSec: number
  segments: Segment[]
  /** 拖动中或点击时调用，用于 seek 预览 */
  onScrub: (sec: number) => void
  /** 拖动段落边界时调用（拖动过程中持续触发） */
  onEdgeDrag: (segmentId: string, edge: 'start' | 'end', sec: number) => void
  /** 拖动结束（松手）时调用一次，用于触发重新吸附 */
  onDragEnd: () => void
}

/**
 * 可拖拽的时间轴。
 *
 * 三种交互：
 *  - 在空白处按下并拖动 → 移动播放头，实时 seek 出对应帧
 *  - 按住某段的左/右边界拖动 → 改该段的起点/终点，同时 seek 预览该帧
 *  - 单击 → 跳到该位置
 *
 * 实时预览靠的就是 seek 本身：<video> 的 currentTime 一改，解码器就吐出那一帧，
 * 不需要处于播放状态。为了避免长视频上连续 seek 造成卡顿，用 rAF 把拖动过程中
 * 的高频 mousemove 折叠成每帧最多一次。
 */
export function Timeline(props: Props) {
  const { durationSec, currentSec, segments } = props
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragTarget | null>(null)
  const [hoverSec, setHoverSec] = useState<number | null>(null)

  // rAF 节流：拖动中每一帧最多处理一次，多余的 mousemove 直接覆盖掉
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<number | null>(null)

  const pxToSec = useCallback(
    (clientX: number): number => {
      const el = trackRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const ratio = (clientX - rect.left) / rect.width
      return Math.max(0, Math.min(1, ratio)) * durationSec
    },
    [durationSec]
  )

  /** 判断按下位置是否命中某段的边界手柄 */
  const hitTestHandle = useCallback(
    (clientX: number): DragTarget | null => {
      const el = trackRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const x = clientX - rect.left
      const secToPx = (sec: number) => (sec / durationSec) * rect.width

      // 从后往前找：视觉上后面的段叠在上层，命中判定要一致
      for (let i = segments.length - 1; i >= 0; i--) {
        const s = segments[i]
        if (s.startSec === null || s.endSec === null || s.endSec <= s.startSec) continue
        if (Math.abs(x - secToPx(s.startSec)) <= HANDLE_HIT_PX) {
          return { kind: 'handle', segmentId: s.id, edge: 'start' }
        }
        if (Math.abs(x - secToPx(Math.min(s.endSec, durationSec))) <= HANDLE_HIT_PX) {
          return { kind: 'handle', segmentId: s.id, edge: 'end' }
        }
      }
      return null
    },
    [segments, durationSec]
  )

  const applyDrag = useCallback(
    (target: DragTarget, sec: number) => {
      if (target.kind === 'playhead') {
        props.onScrub(sec)
      } else {
        props.onEdgeDrag(target.segmentId, target.edge, sec)
        // 拖边界时也 seek，这样能看到那一帧的画面
        props.onScrub(sec)
      }
    },
    [props]
  )

  const onMouseDown = (e: React.MouseEvent) => {
    const hit = hitTestHandle(e.clientX)
    const target: DragTarget = hit ?? { kind: 'playhead' }
    setDrag(target)
    applyDrag(target, pxToSec(e.clientX))
  }

  // 拖拽期间在 window 上监听，这样鼠标移出时间轴范围也不会中断
  useEffect(() => {
    if (!drag) return

    const flush = () => {
      rafRef.current = null
      const sec = pendingRef.current
      if (sec !== null) {
        pendingRef.current = null
        applyDrag(drag, sec)
      }
    }

    const onMove = (e: MouseEvent) => {
      pendingRef.current = pxToSec(e.clientX)
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush)
    }

    const onUp = () => {
      // 松手前把最后一次位置补上，否则可能丢掉最终落点
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (pendingRef.current !== null) {
        applyDrag(drag, pendingRef.current)
        pendingRef.current = null
      }
      setDrag(null)
      props.onDragEnd()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [drag, pxToSec, applyDrag, props])

  const pct = (sec: number) => `${(sec / durationSec) * 100}%`
  // 拖手柄时鼠标可能停在别处，此时不显示 hover 提示
  const showHover = hoverSec !== null && !drag

  return (
    <div
      className={`timeline${drag ? ' dragging' : ''}`}
      ref={trackRef}
      onMouseDown={onMouseDown}
      onMouseMove={(e) => {
        if (!drag) {
          setHoverSec(pxToSec(e.clientX))
          // 悬停在手柄上时换成拖拽光标，提示可拖动
          const el = trackRef.current
          if (el) el.style.cursor = hitTestHandle(e.clientX) ? 'ew-resize' : 'pointer'
        }
      }}
      onMouseLeave={() => setHoverSec(null)}
    >
      {segments.map((s) => {
        // 只有起点、还没设终点的段落：在起点位置留一个标记，样式与配对段落的边界一致
        if (s.startSec !== null && s.endSec === null) {
          return (
            <span
              key={s.id}
              className="timeline-handle start"
              style={{ left: pct(s.startSec) }}
            />
          )
        }
        if (s.startSec === null || s.endSec === null || s.endSec <= s.startSec) return null
        const end = Math.min(s.endSec, durationSec)
        const active =
          drag?.kind === 'handle' && drag.segmentId === s.id ? drag.edge : null
        return (
          <div
            className="timeline-seg"
            key={s.id}
            style={{ left: pct(s.startSec), width: pct(end - s.startSec) }}
          >
            <span className={`timeline-handle start${active === 'start' ? ' active' : ''}`} />
            <span className={`timeline-handle end${active === 'end' ? ' active' : ''}`} />
          </div>
        )
      })}

      <div className="timeline-playhead" style={{ left: pct(currentSec) }} />

      {showHover && (
        <div className="timeline-hover" style={{ left: pct(hoverSec) }}>
          {formatTime(hoverSec)}
        </div>
      )}
    </div>
  )
}
