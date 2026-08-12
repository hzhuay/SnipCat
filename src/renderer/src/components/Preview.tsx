import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import type { Segment, VideoMeta } from '@shared/types'
import { formatTime } from '@shared/time'
import { frameDuration } from '@shared/video'
import { Timeline } from './Timeline'

/** 方向键的跳转步长（秒）。3 秒够跨过一个镜头，又不至于一下跳太远 */
const ARROW_STEP_SEC = 3
/** 按住 Shift 时的大步长，用于快速浏览长视频 */
const ARROW_STEP_LARGE_SEC = 10
/** 画面缩放：步进与边界。默认 100%，画面本身随窗口大小自动伸缩 */
const ZOOM_STEP = 0.25
const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.5

export interface PreviewHandle {
  /** 跳到指定时间并开始播放 */
  playFrom: (sec: number) => void
  /** 只跳转不播放，用于外部触发的预览 */
  seekTo: (sec: number) => void
}

interface Props {
  meta: VideoMeta
  mediaUrl: string | null
  segments: Segment[]
  /** 回车键：由父组件按 resolveEnterAction 的结果处理 */
  onEnter: (currentSec: number) => void
  onSetStart: (sec: number) => void
  onSetEnd: (sec: number) => void
  /** 时间轴上拖动段落边界 */
  onEdgeDrag: (segmentId: string, edge: 'start' | 'end', sec: number) => void
  /** 拖动结束，触发重新吸附 */
  onEdgeDragEnd: () => void
  /** 播放器不可用时通知父组件（用于隐藏时间段行里的播放按钮） */
  onAvailabilityChange?: (available: boolean) => void
}

/**
 * 预览播放器 + 可拖拽时间轴。
 *
 * Electron 的 <video> 只能播 Chromium 支持的容器/编码（H.264/VP9/AV1 + mp4/webm）。
 * HEVC、ProRes、部分 mkv 会无法预览 —— 这时降级为提示文案，切分功能不受影响
 * （切分靠 ffmpeg，不靠 Chromium）。
 *
 * 关于 seek 精度：<video> 的 seek 是帧精确的（解码器内部跳到关键帧后静默解码
 * 到目标位置），所以方向键的 ±3 秒和拖动时间轴看到的都是真实那一帧，不会被
 * 吸附到关键帧。这与流复制切分时的关键帧限制是两回事。
 */
export const Preview = forwardRef<PreviewHandle, Props>(function Preview(props, ref) {
  const { meta, mediaUrl, segments, onAvailabilityChange } = props
  const videoRef = useRef<HTMLVideoElement>(null)
  const [current, setCurrent] = useState(0)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  /** 画面缩放系数（0.5–1.5，默认 1）。基础高度随窗口视口联动，这个系数在基础高度上再缩放 */
  const [zoom, setZoom] = useState(1)

  const duration = meta.durationSec
  const frameStep = frameDuration(meta)

  const seek = useCallback(
    (sec: number) => {
      const el = videoRef.current
      if (!el) return
      const clamped = Math.max(0, Math.min(sec, duration))
      el.currentTime = clamped
      setCurrent(clamped)
    },
    [duration]
  )

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      playFrom: (sec: number) => {
        seek(sec)
        void videoRef.current?.play()
      },
      seekTo: seek,
    }),
    [seek]
  )

  // 换文件后重置状态，否则上一个不支持的文件会让新文件也显示降级提示
  useEffect(() => {
    setFailed(false)
    setCurrent(0)
    setPlaying(false)
  }, [mediaUrl])

  const available = !failed && Boolean(mediaUrl)
  useEffect(() => {
    onAvailabilityChange?.(available)
  }, [available, onAvailabilityChange])

  /**
   * 全局键盘快捷键：← → 跳转、空格 播放/暂停、回车 智能设起点/终点。
   *
   * 挂在 window 上而不是 video 元素上，这样不用先点一下播放器获取焦点。
   * 但要避开输入框 —— 在时间段里打字时方向键该移动光标、空格该输入空格、
   * 回车不该触发打点。
   */
  useEffect(() => {
    if (!available) return

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }

      const now = videoRef.current?.currentTime ?? current
      const step = e.shiftKey ? ARROW_STEP_LARGE_SEC : ARROW_STEP_SEC

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seek(now - step)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        seek(now + step)
      } else if (e.key === ' ') {
        // 空格默认会滚动页面，且可能触发聚焦按钮的点击
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        props.onEnter(now)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [available, seek, togglePlay, current, props])

  if (!available) {
    return (
      <div className="panel">
        <div className="panel-title">预览</div>
        <div className="preview-fallback">
          <span>此格式无法在内置播放器中预览</span>
          <span style={{ fontSize: 12 }}>
            （HEVC / ProRes 等编码 Chromium 不支持）请手动输入时间段，切分功能不受影响
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-title">预览</div>

      {/*
        画面随窗口伸缩：容器高度按视口高度（100vh）换算，宽度铺满面板，
        因此窗口拉大画面变大、窗口缩小画面变小。真实视频靠 object-fit: contain
        等比缩放填进容器，不拉伸变形。
      */}
      <div
        className="preview-stage"
        style={{ height: `calc((100vh - 280px) * ${zoom})` }}
      >
        <video
          className="preview-video"
          ref={videoRef}
          src={mediaUrl ?? undefined}
          preload="metadata"
          onError={() => setFailed(true)}
          onTimeUpdate={(e) => {
            // 拖动期间由拖动逻辑主导位置，忽略播放器自己的时间更新避免抖动
            if (!scrubbing) setCurrent(e.currentTarget.currentTime)
          }}
          onSeeked={(e) => setCurrent(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={togglePlay}
        />

        {/* 画面大小调节：缩小 / 放大 / 恢复默认，浮在画面右下角 */}
        <div className="preview-zoom">
          <button
            className="icon"
            onClick={() =>
              setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
            }
            disabled={zoom <= ZOOM_MIN}
            title="缩小画面"
          >
            −
          </button>
          <span className="preview-zoom-value">{Math.round(zoom * 100)}%</span>
          <button
            className="icon"
            onClick={() =>
              setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
            }
            disabled={zoom >= ZOOM_MAX}
            title="放大画面"
          >
            +
          </button>
          <button
            className="icon"
            onClick={() => setZoom(1)}
            disabled={zoom === 1}
            title="恢复默认大小"
          >
            适应
          </button>
        </div>
      </div>

      <Timeline
        durationSec={duration}
        currentSec={current}
        segments={segments}
        onScrub={(sec) => {
          setScrubbing(true)
          seek(sec)
        }}
        onEdgeDrag={props.onEdgeDrag}
        onDragEnd={() => {
          setScrubbing(false)
          props.onEdgeDragEnd()
        }}
      />

      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => seek(current - ARROW_STEP_SEC)} title="后退 3 秒（←）">
          « 3s
        </button>
        <button onClick={() => seek(current - frameStep)} title="后退一帧">
          ◀|
        </button>
        <button onClick={togglePlay} style={{ minWidth: 72 }} title="播放 / 暂停（空格）">
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button onClick={() => seek(current + frameStep)} title="前进一帧">
          |▶
        </button>
        <button onClick={() => seek(current + ARROW_STEP_SEC)} title="前进 3 秒（→）">
          3s »
        </button>
        <span className="time-readout dim">{formatTime(current)}</span>
        <div className="spacer" />
        <button onClick={() => props.onSetStart(current)}>设为起点</button>
        <button onClick={() => props.onSetEnd(current)}>设为终点</button>
      </div>

      <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
        ← → 跳转 3 秒（Shift 为 10 秒）· 空格 播放/暂停 · 回车 智能打点（先起点再终点）
        <br />
        时间轴：拖动空白处移动播放头，拖动段落两端的竖线可改起点/终点
        <br />
        画面：随窗口大小自动伸缩，右下角 − / + 可手动调节大小
      </div>
    </div>
  )
})
