import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildOutputPath } from '@shared/commands'
import { formatTime } from '@shared/time'
import { resolveEnterAction } from '@shared/interaction'
import { canRun, resolveExecutableSegments, validateSegments } from '@shared/validate'
import type { JobRequest } from '@shared/types'
import { useAppState } from './store'
import { EnvBanner } from './components/EnvBanner'
import { DropZone } from './components/DropZone'
import { MetaPanel } from './components/MetaPanel'
import { Preview, type PreviewHandle } from './components/Preview'
import { SegmentList } from './components/SegmentList'
import { OutputPanel } from './components/OutputPanel'
import { CommandPanel } from './components/CommandPanel'
import { ProgressPanel } from './components/ProgressPanel'

/** 拖动边界时段落的最小时长，避免拖成零长度或反向 */
const MIN_SEGMENT_SEC = 0.1

export function App() {
  const [state, dispatch] = useAppState()
  const { env, meta, segments, mode, suffix, dryRun, job, plan } = state
  const previewRef = useRef<PreviewHandle>(null)
  const [canPlay, setCanPlay] = useState(false)

  const envReady = Boolean(env?.ffmpeg && env?.ffprobe)
  const running = job.jobId !== null && !job.result && !job.error && !job.canceled

  useEffect(() => {
    void window.api.checkEnv().then((e) => dispatch({ type: 'env/loaded', env: e }))
  }, [dispatch])

  // 订阅任务事件
  useEffect(() => {
    return window.api.onJobEvent((jobId, event) => {
      if (jobId !== job.jobId) return
      dispatch({ type: 'job/event', event })
    })
  }, [dispatch, job.jobId])

  const validation = useMemo(() => validateSegments(segments, meta), [segments, meta])

  const outputPath = useMemo(
    () => (meta ? buildOutputPath(meta, suffix) : ''),
    [meta, suffix]
  )

  /**
   * 时间变化后自动求切点吸附结果，让偏移在执行前就显示出来。
   *
   * 防抖 400ms：打字过程中每个字符都跑一次探测太浪费。
   * 只在流复制模式下做 —— 精确模式可以精确切在给定时间。
   */
  const pending = useMemo(() => {
    if (mode !== 'copy' || !meta) return []
    return segments.filter(
      (s) =>
        s.startSec !== null &&
        s.endSec !== null &&
        s.endSec > s.startSec &&
        (s.snappedStartSec === undefined || s.snappedEndSec === undefined)
    )
  }, [segments, mode, meta])

  // 用「id:起点-终点」做依赖键，避免数组身份变化导致重复请求
  const pendingKey = pending.map((s) => `${s.id}:${s.startSec}-${s.endSec}`).join(',')

  useEffect(() => {
    if (!meta || pending.length === 0 || running) return
    let alive = true
    const timer = setTimeout(() => {
      const ids = pending.map((s) => s.id)
      const targets = pending.map(
        (s) => [s.startSec as number, s.endSec as number] as [number, number]
      )
      window.api
        .snapSegments(meta.path, targets, meta.durationSec)
        .then((snaps) => {
          if (alive) dispatch({ type: 'seg/applySnaps', snaps, ids })
        })
        // 吸附失败不该打断编辑，执行时 job 会再算一次并给出真正的错误
        .catch(() => undefined)
    }, 400)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, pendingKey, running, dispatch])

  const loadFile = useCallback(
    async (path: string) => {
      dispatch({ type: 'probe/start' })
      try {
        const m = await window.api.probe(path)
        const url = await window.api.mediaUrl(path)
        dispatch({ type: 'probe/success', meta: m, mediaUrl: url })
      } catch (e) {
        dispatch({ type: 'probe/failure', message: (e as Error).message })
      }
    },
    [dispatch]
  )

  const pickFile = useCallback(async () => {
    const p = await window.api.pickVideo()
    if (p) await loadFile(p)
  }, [loadFile])

  /** 「设为起点」：写入最后一个起点为空的段落，没有则新建一段 */
  const setStartFromPlayhead = useCallback(
    (sec: number) => {
      const target = [...segments].reverse().find((s) => s.startRaw.trim() === '')
      if (target) {
        dispatch({ type: 'seg/edit', id: target.id, field: 'startRaw', value: formatTime(sec) })
      } else {
        dispatch({ type: 'seg/addWith', startRaw: formatTime(sec) })
      }
    },
    [segments, dispatch]
  )

  /** 「设为终点」：写入最后一个已填起点但终点为空的段落，没有则填最后一段 */
  const setEndFromPlayhead = useCallback(
    (sec: number) => {
      const target = [...segments]
        .reverse()
        .find((s) => s.startRaw.trim() !== '' && s.endRaw.trim() === '')
      const id = target?.id ?? segments[segments.length - 1]?.id
      if (id) dispatch({ type: 'seg/edit', id, field: 'endRaw', value: formatTime(sec) })
    },
    [segments, dispatch]
  )

  /**
   * 回车键：智能判定设起点还是终点。
   *
   * 判定规则在 shared/interaction.ts 里（纯函数，已单测）：有半截的段落时，
   * 播放头在其起点之后则补终点，在起点上或之前则把起点挪到当前位置；
   * 都完整了就开始标新的一段。
   */
  const handleEnter = useCallback(
    (sec: number) => {
      const action = resolveEnterAction(segments, sec)
      const value = formatTime(sec)

      switch (action.kind) {
        case 'setEnd':
          dispatch({ type: 'seg/edit', id: action.segmentId, field: 'endRaw', value })
          break
        case 'setStart':
          dispatch({ type: 'seg/edit', id: action.segmentId, field: 'startRaw', value })
          break
        case 'addWithStart':
          dispatch({ type: 'seg/addWith', startRaw: value })
          break
      }
    },
    [segments, dispatch]
  )

  /**
   * 时间轴上拖动段落边界。
   *
   * 拖动过程中直接写 startRaw/endRaw —— 这样输入框里的数字跟着动，用户能看到
   * 精确值。吸附结果会因为时间变化被自动清掉（见 store 的 editSegment），
   * 松手后由防抖的吸附逻辑重新算。
   */
  const handleEdgeDrag = useCallback(
    (segmentId: string, edge: 'start' | 'end', sec: number) => {
      const seg = segments.find((s) => s.id === segmentId)
      if (!seg) return

      // 不允许拖过对面那一端，否则会出现 end <= start 的非法区间
      let clamped = sec
      if (edge === 'start' && seg.endSec !== null) {
        clamped = Math.min(sec, seg.endSec - MIN_SEGMENT_SEC)
      } else if (edge === 'end' && seg.startSec !== null) {
        clamped = Math.max(sec, seg.startSec + MIN_SEGMENT_SEC)
      }
      clamped = Math.max(0, Math.min(clamped, meta?.durationSec ?? clamped))

      dispatch({
        type: 'seg/edit',
        id: segmentId,
        field: edge === 'start' ? 'startRaw' : 'endRaw',
        value: formatTime(clamped),
      })
    },
    [segments, dispatch, meta]
  )

  const buildRequest = useCallback((): JobRequest | null => {
    if (!meta) return null
    const exec = resolveExecutableSegments(segments, meta)
    if (exec.length === 0) return null
    return { input: meta, segments: exec, mode, outputPath }
  }, [meta, segments, mode, outputPath])

  const doPlan = useCallback(async () => {
    const req = buildRequest()
    if (!req) return
    dispatch({ type: 'plan/start' })
    try {
      const commands = await window.api.planJob(req)
      dispatch({ type: 'plan/done', commands })
    } catch (e) {
      dispatch({ type: 'plan/failed', message: (e as Error).message })
    }
  }, [buildRequest, dispatch])

  const doRun = useCallback(async () => {
    const req = buildRequest()
    if (!req) return

    // 不静默覆盖用户目录里已有的文件
    const check = await window.api.checkOutput(req.outputPath)
    let finalPath = req.outputPath
    if (check.exists) {
      const alt = check.alternative.split('/').pop()
      const ok = window.confirm(
        `${req.outputPath.split('/').pop()} 已存在。\n\n确定 = 覆盖\n取消 = 改名为 ${alt}`
      )
      if (!ok) finalPath = check.alternative
    }

    try {
      const { jobId } = await window.api.startJob({ ...req, outputPath: finalPath })
      dispatch({ type: 'job/started', jobId })
    } catch (e) {
      dispatch({ type: 'plan/failed', message: (e as Error).message })
    }
  }, [buildRequest, dispatch])

  const runnable =
    envReady &&
    !running &&
    suffix.trim() !== '' &&
    canRun(segments, meta, validation)

  return (
    <div className="app">
      <EnvBanner
        env={env}
        onRecheck={() =>
          void window.api.checkEnv(true).then((e) => dispatch({ type: 'env/loaded', env: e }))
        }
      />

      <DropZone
        hasFile={meta !== null}
        disabled={running || state.probing}
        onPick={() => void pickFile()}
        onDropFile={(p) => void loadFile(p)}
      />

      {state.probing && <div className="panel dim">正在读取元数据…</div>}

      {state.probeError && (
        <div className="panel">
          <span className="status-error">✗ </span>
          <span>{state.probeError}</span>
        </div>
      )}

      {meta && (
        <>
          <MetaPanel meta={meta} />

          <Preview
            ref={previewRef}
            meta={meta}
            mediaUrl={state.mediaUrl}
            segments={segments}
            onEnter={handleEnter}
            onSetStart={setStartFromPlayhead}
            onSetEnd={setEndFromPlayhead}
            onEdgeDrag={handleEdgeDrag}
            onEdgeDragEnd={() => dispatch({ type: 'plan/clear' })}
            onAvailabilityChange={setCanPlay}
          />

          <SegmentList
            meta={meta}
            segments={segments}
            issues={validation.issues}
            mode={mode}
            totalDurationSec={validation.totalDurationSec}
            disabled={running}
            canPlay={canPlay}
            onAdd={() => dispatch({ type: 'seg/add' })}
            onRemove={(id) => dispatch({ type: 'seg/remove', id })}
            onEdit={(id, field, value) => dispatch({ type: 'seg/edit', id, field, value })}
            onNormalize={(id, field, value) =>
              dispatch({ type: 'seg/normalize', id, field, value })
            }
            onMove={(from, to) => dispatch({ type: 'seg/move', from, to })}
            onSort={() => dispatch({ type: 'seg/sort' })}
            onPlaySegment={(sec) => previewRef.current?.playFrom(sec)}
          />

          <OutputPanel
            meta={meta}
            suffix={suffix}
            outputPath={outputPath}
            mode={mode}
            dryRun={dryRun}
            disabled={running}
            onSuffixChange={(v) => dispatch({ type: 'suffix/set', suffix: v })}
            onModeChange={(m) => dispatch({ type: 'mode/set', mode: m })}
            onDryRunChange={(v) => dispatch({ type: 'dryRun/set', value: v })}
          />

          {plan && (
            <CommandPanel commands={plan} onClose={() => dispatch({ type: 'plan/clear' })} />
          )}

          {(running || job.result || job.error || job.canceled) && (
            <ProgressPanel
              job={job}
              onCancel={() => job.jobId && void window.api.cancelJob(job.jobId)}
              onReset={() => dispatch({ type: 'job/reset' })}
              onReveal={(p) => void window.api.reveal(p)}
            />
          )}

          {!running && !job.result && (
            <div className="row" style={{ justifyContent: 'center', padding: '4px 0 8px' }}>
              <button
                className="primary"
                disabled={!runnable || state.planning}
                onClick={() => void (dryRun ? doPlan() : doRun())}
              >
                {state.planning ? '生成中…' : dryRun ? '生成命令' : '开始处理'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
