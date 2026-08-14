import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
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
import { LogPanel } from './components/LogPanel'
import { MenuBar, type View } from './components/MenuBar'
import { TaskPanel } from './components/TaskPanel'

/** 拖动边界时段落的最小时长，避免拖成零长度或反向 */
const MIN_SEGMENT_SEC = 0.1

export function App() {
  const [state, dispatch] = useAppState()
  const { env, meta, segments, mode, encoder, suffix, dryRun, job, plan, logs, tasks } = state
  const previewRef = useRef<PreviewHandle>(null)
  const [canPlay, setCanPlay] = useState(false)
  /** 菜单栏当前视图：主流程 / 后台任务 / 日志 */
  const [view, setView] = useState<View>('workflow')
  /** 硬件 AV1 编码器（av1_amf）是否可用 */
  const [amfAvailable, setAmfAvailable] = useState(false)
  /** 全页面拖放：正在拖入文件时的遮罩提示与失败原因 */
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)

  const envReady = Boolean(env?.ffmpeg && env?.ffprobe)
  const running = job.jobId !== null && !job.result && !job.error && !job.canceled

  useEffect(() => {
    void window.api.checkEnv().then((e) => dispatch({ type: 'env/loaded', env: e }))
  }, [dispatch])

  // 探测硬件 AV1 编码器是否可用，决定「编码器」选项里硬件项能否选。
  // 默认编码器是 amf（硬件优先），但机器上没有 av1_amf 时回退软件 svtav1，
  // 否则默认状态下直接运行会因找不到编码器失败。
  useEffect(() => {
    void window.api.checkEncoders().then((enc) => {
      const hasAmf = Boolean(enc.amf)
      setAmfAvailable(hasAmf)
      if (!hasAmf) dispatch({ type: 'encoder/set', encoder: 'svtav1' })
    })
  }, [])

  // 订阅任务事件：只用 ref 读最新前台 jobId，把前台任务的事件交给 ProgressPanel；
  // 后台压缩任务的进度/状态由 task:event 提供，job:event 里其它 jobId 忽略。
  const fgJobIdRef = useRef(job.jobId)
  fgJobIdRef.current = job.jobId
  useEffect(() => {
    return window.api.onJobEvent((jobId, event) => {
      if (jobId === fgJobIdRef.current) dispatch({ type: 'job/event', event })
    })
  }, [dispatch])

  // 订阅后台任务列表更新（task:event 推送完整任务）
  useEffect(() => {
    return window.api.onTaskEvent((task) => dispatch({ type: 'task/upsert', task }))
  }, [dispatch])

  // 订阅全局处理日志（探测、吸附、切分、拼接的中间过程）
  useEffect(() => {
    return window.api.onLogEvent((entry) => dispatch({ type: 'log/add', entry }))
  }, [dispatch])

  // 挂载：载入已保存的后台任务 + 用户偏好 + 恢复上次编辑会话（时间段自动找回）
  useEffect(() => {
    void window.api
      .listTasks()
      .then((tasks) => dispatch({ type: 'task/list', tasks }))
      .catch(() => undefined)

    // 用户偏好（模式 + 编码器）先于会话恢复应用；会话恢复若存在会覆盖为当时的模式
    void window.api.loadPrefs().then((prefs) => {
      if (prefs) dispatch({ type: 'prefs/loaded', prefs })
    })

    void window.api.loadSession().then(async (session) => {
      if (!session) return
      try {
        const m = await window.api.probe(session.inputPath)
        const url = await window.api.mediaUrl(session.inputPath)
        dispatch({
          type: 'session/restored',
          meta: m,
          mediaUrl: url,
          segments: session.segments,
          mode: session.mode,
          suffix: session.suffix,
          encoder: session.encoder ?? 'svtav1',
        })
        setView('workflow')
      } catch {
        // 上次的视频文件已被删除/移动，静默跳过恢复
      }
    })
  }, [dispatch])

  // 编辑会话自动保存：源视频 + 时间段 + 模式 + 后缀 + 编码器（600ms 防抖）
  useEffect(() => {
    if (!meta) return
    const timer = setTimeout(() => {
      void window.api.saveSession({
        inputPath: meta.path,
        segments: segments.map((s) => ({ startRaw: s.startRaw, endRaw: s.endRaw })),
        mode,
        suffix,
        encoder,
        updatedAt: Date.now(),
      })
    }, 600)
    return () => clearTimeout(timer)
  }, [meta, segments, mode, suffix, encoder])

  // 用户偏好自动保存：模式 + 编码器改动即落盘（跳过首次挂载，避免覆盖刚加载的偏好）。
  // 与会话解耦 —— 即使没加载视频或视频已删除，偏好也不丢。
  const firstPrefsSave = useRef(true)
  useEffect(() => {
    if (firstPrefsSave.current) {
      firstPrefsSave.current = false
      return
    }
    void window.api.savePrefs({ mode, encoder })
  }, [mode, encoder])

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
        // 从后台任务/日志视图拖入新文件时，自动切回主流程
        setView('workflow')
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

  /**
   * 全页面拖放：不再限制在专门的拖放区，窗口任意位置拖入视频都能导入。
   * 用 dragenter/dragleave 计数，避免在子元素之间移动时遮罩闪烁。
   */
  const handleDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const handleDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    // 必须 preventDefault，否则浏览器默认行为不允许 drop
    e.preventDefault()
  }

  const handleDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (running || state.probing) return

    const file = e.dataTransfer.files[0]
    if (!file) {
      setDropError('没有识别到文件，请直接拖入一个视频文件')
      return
    }
    const path = window.api.pathForFile(file)
    if (!path) {
      // 拖入的可能不是真实磁盘文件（如浏览器里的图片、压缩包内的条目）
      setDropError(`无法获取「${file.name}」的磁盘路径，请改用「选择文件」`)
      return
    }
    setDropError(null)
    void loadFile(path)
  }

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
    return { input: meta, segments: exec, mode, outputPath, suffix, encoder }
  }, [meta, segments, mode, outputPath, suffix, encoder])

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
      const { jobId, lane } = await window.api.startJob({ ...req, outputPath: finalPath })
      // 前台流复制进 ProgressPanel；压缩进后台队列（queued 事件已建队列项）
      if (lane === 'fg') dispatch({ type: 'job/started', jobId })
    } catch (e) {
      dispatch({ type: 'plan/failed', message: (e as Error).message })
    }
  }, [buildRequest, dispatch])

  /** 往全局日志里追加一条错误（供后台任务的异常在日志视图可见） */
  const pushErrorLog = useCallback(
    (message: string) => {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      dispatch({
        type: 'log/add',
        entry: { ts: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, level: 'error', message },
      })
    },
    [dispatch]
  )

  /** 重新运行已保存的压缩任务（主进程用保存的时间段重新入队） */
  const resumeTask = useCallback(
    async (taskId: string) => {
      try {
        await window.api.resumeTask(taskId)
      } catch (e) {
        pushErrorLog(`重新运行失败：${(e as Error).message}`)
      }
    },
    [pushErrorLog]
  )

  /** 把任务的时间段/mode/后缀载入编辑器微调 */
  const loadTaskIntoEditor = useCallback(
    async (taskId: string) => {
      try {
        const t = await window.api.loadTaskIntoEditor(taskId)
        const m = await window.api.probe(t.inputPath)
        const url = await window.api.mediaUrl(t.inputPath)
        dispatch({
          type: 'session/restored',
          meta: m,
          mediaUrl: url,
          segments: t.segments,
          mode: t.mode,
          suffix: t.suffix,
          encoder: t.encoder ?? 'svtav1',
        })
        setView('workflow')
      } catch (e) {
        pushErrorLog(`载入任务失败：${(e as Error).message}`)
      }
    },
    [dispatch, pushErrorLog]
  )

  const runnable =
    envReady &&
    !running &&
    suffix.trim() !== '' &&
    canRun(segments, meta, validation)

  const activeTaskCount = tasks.filter(
    (t) => t.status === 'queued' || t.status === 'running' || t.status === 'paused'
  ).length

  return (
    <div
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <MenuBar view={view} activeTaskCount={activeTaskCount} onSelect={setView} />

      <div className="app">
      {view === 'tasks' && (
        <TaskPanel
          tasks={tasks}
          onCancel={(jobId) => void window.api.cancelJob(jobId)}
          onReveal={(p) => void window.api.reveal(p)}
          onResume={(taskId) => void resumeTask(taskId)}
          onLoad={(taskId) => void loadTaskIntoEditor(taskId)}
          onDelete={(taskId) =>
            void window.api.deleteTask(taskId).then(() => dispatch({ type: 'task/delete', taskId }))
          }
          onDeleteSource={(taskId) => void window.api.deleteSource(taskId)}
          onClearFinished={() =>
            void window.api.clearFinished().then((list) => dispatch({ type: 'task/list', tasks: list }))
          }
        />
      )}

      {view === 'logs' && (
        <LogPanel logs={logs} onClear={() => dispatch({ type: 'log/clear' })} />
      )}

      {view === 'workflow' && (
        <>
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
      />

      {state.probing && <div className="panel dim">正在读取元数据…</div>}

      {state.probeError && (
        <div className="panel">
          <span className="status-error">✗ </span>
          <span>{state.probeError}</span>
        </div>
      )}

      {dropError && (
        <div className="panel">
          <span className="status-error">✗ </span>
          <span>{dropError}</span>
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
            encoder={encoder}
            amfAvailable={amfAvailable}
            dryRun={dryRun}
            disabled={running}
            onSuffixChange={(v) => dispatch({ type: 'suffix/set', suffix: v })}
            onModeChange={(m) => dispatch({ type: 'mode/set', mode: m })}
            onEncoderChange={(enc) => dispatch({ type: 'encoder/set', encoder: enc })}
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
        </>
      )}

      {dragging && (
        <div className="drop-overlay">
          <span>松开以导入视频</span>
        </div>
      )}
      </div>
    </div>
  )
}
