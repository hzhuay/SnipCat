/**
 * 任务编排：切段 → 拼接 → 落地 → 清理。
 *
 * 命令构造全部委托给 @shared/commands 的纯函数，这里只负责副作用
 * （建临时目录、跑进程、移动文件、推事件）。Dry-run 与真实执行调用
 * 同一个 buildJobCommands，所以界面上显示的命令就是实际会跑的命令。
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildJobCommands } from '@shared/commands'
import {
  COPY_WEIGHTS,
  RECODE_WEIGHTS,
  overallRatio,
  estimateEta,
} from '@shared/progress'
import type { CommandSpec, JobEvent, JobRequest } from '@shared/types'
import { requireBinaries } from './locate'
import { snapSegments } from './keyframes'
import { CanceledError, FFmpegError, ProcessHandle, runChecked } from './runner'

export type EventSink = (e: JobEvent) => void

/** 建一个本次任务专属的临时目录。放系统临时目录而不是源视频目录，避免污染工作目录。 */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'videocut-'))
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响主流程，系统重启后临时目录会被回收
  }
}

/**
 * 把暂存文件落到最终位置。
 *
 * 先写临时目录再移动，这样取消或失败时不会在源目录留下半成品。
 * rename 在同一分区是原子的；跨分区会失败（EXDEV），降级为复制。
 */
function finalize(staged: string, outputPath: string): void {
  try {
    renameSync(staged, outputPath)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw e
    copyFileSync(staged, outputPath)
    try {
      rmSync(staged, { force: true })
    } catch {
      /* 临时文件，稍后随目录一起清理 */
    }
  }
}

/**
 * 为请求补全切点吸附结果。
 *
 * 只在流复制模式下做 —— 精确模式重编码，可以精确切在用户给的时间点。
 * 起点向前、终点向后，两端都向外扩，宁可多带几帧也不丢内容。
 */
export async function resolveSnapping(req: JobRequest, handle?: ProcessHandle): Promise<JobRequest> {
  if (req.mode !== 'copy') return req

  const targets = req.segments.map(
    (s) => [s.startSec as number, s.endSec as number] as [number, number]
  )
  const snaps = await snapSegments(req.input.path, targets, req.input.durationSec, handle)

  return {
    ...req,
    segments: req.segments.map((s, i) => ({
      ...s,
      snappedStartSec: snaps[i]?.startSec,
      snappedEndSec: snaps[i]?.endSec,
    })),
  }
}

/**
 * Dry-run：只构造命令，不执行任何写操作。
 *
 * 临时目录用占位路径而非真建目录 —— Dry-run 不该在磁盘上留任何东西。
 * 吸附仍会真跑 ffprobe（只读操作），这样显示的 -ss 就是实际会用的值；
 * 吸附失败时降级为不吸附并继续，因为 Dry-run 的价值在于看命令形态，
 * 不该因为探测出问题就什么都看不到。
 */
export async function planJob(req: JobRequest): Promise<CommandSpec[]> {
  let resolved = req
  try {
    resolved = await resolveSnapping(req)
  } catch {
    // 保持未吸附状态，命令里的 -ss 会是用户输入的原始时间
  }
  const tmpDir = join(tmpdir(), 'videocut-<临时目录>')
  const { commands } = buildJobCommands(
    resolved.input,
    resolved.segments,
    resolved.mode,
    resolved.outputPath,
    tmpDir
  )
  return commands
}

/**
 * 执行一次完整任务。
 *
 * @param req 已校验的请求（段落均合法、outputPath 已确定）
 * @param handle 用于取消
 * @param emit 事件推送
 */
export async function runJob(
  req: JobRequest,
  handle: ProcessHandle,
  emit: EventSink
): Promise<void> {
  const startedAt = Date.now()
  const { ffmpeg } = await requireBinaries()
  const tmpDir = makeTmpDir()

  try {
    // 切点吸附
    if (req.mode === 'copy') {
      emit({ type: 'stage', stage: 'keyframe' })
    }
    const resolved = await resolveSnapping(req, handle)
    handle.throwIfCanceled()

    const plan = buildJobCommands(
      resolved.input,
      resolved.segments,
      resolved.mode,
      resolved.outputPath,
      tmpDir
    )
    emit({ type: 'plan', commands: plan.commands })

    const weights = req.mode === 'copy' ? COPY_WEIGHTS : RECODE_WEIGHTS
    const total = plan.totalDurationSec
    let completedCutSec = 0

    const pushProgress = (currentCut: number, concatSec: number) => {
      const ratio = overallRatio(completedCutSec, currentCut, total, concatSec, weights)
      const elapsed = (Date.now() - startedAt) / 1000
      emit({ type: 'progress', ratio, etaSec: estimateEta(elapsed, ratio) })
    }

    // 切段
    const cutCount = resolved.segments.length
    for (let i = 0; i < cutCount; i++) {
      handle.throwIfCanceled()
      const cmd = plan.commands[i]
      emit({ type: 'stage', stage: 'cut', index: i + 1, total: cutCount })

      await runChecked(ffmpeg, cmd.argv, {
        handle,
        onProgress: (sec) => pushProgress(Math.min(sec, cmd.expectedDurationSec ?? sec), 0),
        onLog: (line) => emit({ type: 'log', line }),
      })

      completedCutSec += cmd.expectedDurationSec ?? 0
      pushProgress(0, 0)
    }

    // 拼接
    if (plan.needsConcat) {
      handle.throwIfCanceled()
      emit({ type: 'stage', stage: 'concat' })
      writeFileSync(plan.listPath, plan.listContent, 'utf8')

      const concatCmd = plan.commands[plan.commands.length - 1]
      await runChecked(ffmpeg, concatCmd.argv, {
        handle,
        onProgress: (sec) => pushProgress(0, sec),
        onLog: (line) => emit({ type: 'log', line }),
      })
    }

    // 落地
    handle.throwIfCanceled()
    emit({ type: 'stage', stage: 'finalize' })
    if (!existsSync(plan.stagedOutput)) {
      throw new Error('ffmpeg 未产出输出文件，请查看日志')
    }
    finalize(plan.stagedOutput, req.outputPath)

    emit({ type: 'progress', ratio: 1 })
    emit({
      type: 'done',
      outputPath: req.outputPath,
      elapsedSec: (Date.now() - startedAt) / 1000,
    })
  } catch (e) {
    if (e instanceof CanceledError || handle.isCanceled) {
      emit({ type: 'canceled' })
    } else if (e instanceof FFmpegError) {
      emit({ type: 'error', message: e.message, stderrTail: e.stderrTail })
    } else {
      emit({ type: 'error', message: (e as Error).message, stderrTail: [] })
    }
  } finally {
    cleanup(tmpDir)
  }
}
