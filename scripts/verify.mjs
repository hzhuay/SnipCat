/**
 * 端到端验证：直接驱动主进程的真实执行链路（probe → 关键帧吸附 → 切段 → 拼接 → 落地）。
 *
 * 不经过 Electron —— job.ts / probe.ts / keyframes.ts / runner.ts 都只依赖 node，
 * 所以可以在这里原样跑一遍，验证的就是 GUI 点「开始处理」时执行的同一套代码。
 *
 * 用法：node out/tools/verify.mjs <视频路径>
 */

import { existsSync, statSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { probeVideo } from '../src/main/ffmpeg/probe.ts'
import { runJob, resolveSnapping } from '../src/main/ffmpeg/job.ts'
import { ProcessHandle } from '../src/main/ffmpeg/runner.ts'
import { locateBinaries } from '../src/main/ffmpeg/locate.ts'
import { buildOutputPath } from '../src/shared/commands.ts'
import { parseTime, formatTime } from '../src/shared/time.ts'
import { resolveExecutableSegments } from '../src/shared/validate.ts'

const input = resolve(process.argv[2] ?? '')
if (!existsSync(input)) {
  console.error(`找不到文件：${input}`)
  process.exit(1)
}

const line = (c = '─') => c.repeat(74)
let failures = 0

function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

// ── 环境 ────────────────────────────────────────────
const env = await locateBinaries()
console.log(`\n${line()}\n环境`)
check('ffmpeg', Boolean(env.ffmpeg), env.ffmpeg ?? '')
check('ffprobe', Boolean(env.ffprobe), env.ffprobe ?? '')
console.log(`  ${env.version ?? ''}`)

// ── 元数据 ──────────────────────────────────────────
console.log(`\n${line()}\n元数据探测`)
const meta = await probeVideo(input)
const v = meta.streams.find((s) => s.codecType === 'video')
console.log(`  ${meta.base}${meta.ext}`)
console.log(`  ${v.codecName} ${v.profile} ${v.width}×${v.height} ${v.pixFmt} ${v.rFrameRate}`)
console.log(`  时长 ${formatTime(meta.durationSec)} · ${(meta.sizeBytes / 1048576).toFixed(1)} MB`)
check('时长 > 0', meta.durationSec > 0)
check('识别到视频流', Boolean(v))

// ── 切点吸附 ────────────────────────────────────────
// 故意选不在关键帧上的时间点：视频每 2 秒一个关键帧，13 和 21.5 都会被向外扩
const rawSegments = [
  ['00:00:13', '00:00:17'],
  ['21.5', '25'],
  ['4', '6'],
]

const edited = rawSegments.map(([s, e], i) => ({
  id: `seg-${i}`,
  startRaw: s,
  endRaw: e,
  startSec: parseTime(s),
  endSec: parseTime(e),
}))
const segments = resolveExecutableSegments(edited, meta)

console.log(`\n${line()}\n切点吸附（起点向前、终点向后，宁可多切不要缺）`)
const snapped = await resolveSnapping(
  { input: meta, segments, mode: 'copy', outputPath: '' },
  undefined
)
for (const s of snapped.segments) {
  const headExtra = s.startSec - s.snappedStartSec
  const tailExtra = s.snappedEndSec - s.endSec
  console.log(
    `  ${s.startRaw} → ${s.endRaw}   实际 ${formatTime(s.snappedStartSec)} → ${formatTime(s.snappedEndSec)}` +
      `   头 +${headExtra.toFixed(2)}s / 尾 +${tailExtra.toFixed(2)}s`
  )
  // 方向正确性：两端都必须向外，任何一端向内都意味着丢内容
  check(`  起点未晚于输入（不丢头）`, s.snappedStartSec <= s.startSec + 1e-6)
  check(`  终点未早于输入（不丢尾）`, s.snappedEndSec >= s.endSec - 1e-6)
  check(`  终点不超过视频时长`, s.snappedEndSec <= meta.durationSec + 1e-6)
}

// ── 执行 ────────────────────────────────────────────
const outputPath = buildOutputPath(meta, '_cut')
if (existsSync(outputPath)) rmSync(outputPath)

console.log(`\n${line()}\n执行`)
const handle = new ProcessHandle()
const seenStages = []
let lastRatio = 0
let ratioMonotonic = true
let progressCount = 0
let result = null
let error = null

await runJob({ input: meta, segments, mode: 'copy', outputPath }, handle, (e) => {
  if (e.type === 'stage') {
    const tag = e.index ? `${e.stage}(${e.index}/${e.total})` : e.stage
    seenStages.push(tag)
    console.log(`  阶段 ${tag}`)
  } else if (e.type === 'progress') {
    progressCount++
    if (e.ratio < lastRatio - 1e-9) ratioMonotonic = false
    lastRatio = e.ratio
  } else if (e.type === 'done') {
    result = e
  } else if (e.type === 'error') {
    error = e
    console.log(`  ✗ ${e.message}`)
    for (const l of e.stderrTail) console.log(`    ${l}`)
  }
})

check('任务成功完成', result !== null && error === null)
check('收到进度事件', progressCount > 0, `${progressCount} 次`)
check('进度单调不回退', ratioMonotonic)
check('最终进度到 1', Math.abs(lastRatio - 1) < 1e-9, lastRatio.toFixed(3))
check('走过切分阶段', seenStages.some((s) => s.startsWith('cut')))
check('走过拼接阶段', seenStages.includes('concat'))

if (!result) {
  console.log(`\n执行失败，中止后续校验\n`)
  process.exit(1)
}

// ── 输出比对 ────────────────────────────────────────
console.log(`\n${line()}\n输出校验`)
check('输出文件存在', existsSync(outputPath), outputPath)
const outMeta = await probeVideo(outputPath)
const ov = outMeta.streams.find((s) => s.codecType === 'video')
const ia = meta.streams.find((s) => s.codecType === 'audio')
const oa = outMeta.streams.find((s) => s.codecType === 'audio')

console.log(`  耗时 ${result.elapsedSec.toFixed(2)}s · ${(statSync(outputPath).size / 1048576).toFixed(1)} MB`)
console.log(`\n  逐字段比对（输入 vs 输出）`)
for (const f of ['codecName', 'profile', 'width', 'height', 'pixFmt', 'rFrameRate']) {
  check(`  ${f}: ${v[f]} vs ${ov[f]}`, String(v[f]) === String(ov[f]))
}
if (ia && oa) {
  for (const f of ['codecName', 'sampleRate', 'channels']) {
    check(`  audio.${f}: ${ia[f]} vs ${oa[f]}`, String(ia[f]) === String(oa[f]))
  }
}

const requested = snapped.segments.reduce((sum, s) => sum + (s.endSec - s.startSec), 0)
// 每段的实际时长 = 落点 → 吸附后终点。用落点而非请求起点，因为 ffmpeg 会向前落。
const expected = snapped.segments.reduce(
  (sum, s) => sum + (s.snappedEndSec - s.snappedStartSec),
  0
)
console.log(
  `\n  时长  用户请求 ${requested.toFixed(3)}s  含吸附余量 ${expected.toFixed(3)}s  实际 ${outMeta.durationSec.toFixed(3)}s`
)

/**
 * 时长容差要按段数放大。
 *
 * 每段末尾都会落在 packet 边界上，误差按段累加；mkv 上 packet 粒度更粗
 * （cluster 级），单段可能多出一个 GOP。这里给每段 1.5s 的容差 —— 严格性由
 * 逐帧哈希校验保证（它是精确比对），时长只用来兜住量级异常。
 */
const durTolerance = 0.5 + snapped.segments.length * 1.5
const diff = Math.abs(outMeta.durationSec - expected)
check(
  `  时长在容差内（±${durTolerance.toFixed(1)}s，逐帧哈希才是精确校验）`,
  diff < durTolerance,
  `差 ${diff.toFixed(3)}s`
)
// 两端向外扩的核心保证：输出必然涵盖用户要的全部内容
check('  输出不短于用户请求（内容无缺失）', outMeta.durationSec >= requested - 0.05)

// ── 内容正确性：逐帧哈希 ────────────────────────────
// 参数一致不代表切对了位置。用帧哈希确认输出的每一帧都来自源的对应位置 ——
// 之前正是靠这个发现了 mkv 上切点偏移 2 秒的 bug（UI 显示 12s 而内容从 10s 开始）
console.log(`\n${line()}\n内容校验（逐帧哈希）`)
const { execFileSync } = await import('node:child_process')
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const hashDir = mkdtempSync(join(tmpdir(), 'videocut-verify-'))

function videoFrameHashes(args) {
  const out = execFileSync(
    env.ffmpeg,
    ['-v', 'error', ...args, '-an', '-f', 'framehash', '-hash', 'md5', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  return out
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').pop().trim())
}

/**
 * 期望：把源按**真实命令的语义**逐段切出来（-ss 传原始起点、-t 相对原始起点），
 * 哈希依次相接。
 *
 * 必须先落地成文件再读哈希 —— 管道输出的 matroska 是不可 seek 的，ffmpeg 会写出
 * 不同的结构，帧哈希与写文件的结果不一致（实测过），那样就不是在比同一件事。
 */
const expectedHashes = []
snapped.segments.forEach((s, i) => {
  const segFile = join(hashDir, `expect_${i}${meta.ext}`)
  execFileSync(env.ffmpeg, [
    '-v', 'error', '-y',
    '-ss', String(s.startSec),
    '-i', input,
    '-t', String(s.snappedEndSec - s.startSec),
    '-map', '0:v:0',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    segFile,
  ])
  expectedHashes.push(...videoFrameHashes(['-i', segFile]))
})
const actualHashes = videoFrameHashes(['-i', outputPath])

console.log(`  期望 ${expectedHashes.length} 帧 · 实际 ${actualHashes.length} 帧`)
check('  帧数一致', expectedHashes.length === actualHashes.length)
const firstMismatch = actualHashes.findIndex((h, i) => h !== expectedHashes[i])
check(
  '  每一帧的内容与源片段完全相同',
  firstMismatch === -1 && expectedHashes.length === actualHashes.length,
  firstMismatch >= 0 ? `第 ${firstMismatch + 1} 帧起不一致` : ''
)

// 单独确认首帧：这是切点是否正确的最直接证据
const srcAtStart = videoFrameHashes([
  '-ss', String(snapped.segments[0].snappedStartSec),
  '-i', input,
  '-frames:v', '1',
])
check(
  `  首帧确实取自 ${formatTime(snapped.segments[0].snappedStartSec)}`,
  actualHashes[0] === srcAtStart[0]
)

// ── 取消 ────────────────────────────────────────────
console.log(`\n${line()}\n取消`)
const cancelOut = buildOutputPath(meta, '_cancel_test')
if (existsSync(cancelOut)) rmSync(cancelOut)
const h2 = new ProcessHandle()
let canceled = false
let cancelErr = null

// 整片重编码，保证足够慢，能在完成前取消掉。
// 小分辨率的测试视频重编码也很快，所以取消要发得早一些。
const longSeg = [
  {
    id: 'c0',
    startRaw: '0',
    endRaw: String(meta.durationSec),
    startSec: 0,
    endSec: meta.durationSec,
  },
]
const p = runJob({ input: meta, segments: longSeg, mode: 'precise', outputPath: cancelOut }, h2, (e) => {
  if (e.type === 'canceled') canceled = true
  if (e.type === 'error') cancelErr = e
  // 一收到第一个进度事件就取消 —— 此时 ffmpeg 确实在跑，取消才有意义
  if (e.type === 'progress' && !h2.isCanceled) h2.cancel()
})
// 兜底：万一没有进度事件（任务瞬间完成），定时取消
setTimeout(() => h2.cancel(), 400)
await p

const cancelDetail = cancelErr
  ? `却收到 error: ${cancelErr.message}`
  : canceled
    ? ''
    : '任务在取消生效前已完成（测试视频太短），非产品问题'
check('收到 canceled 事件', canceled, cancelDetail)
check('取消后不留下输出文件', !existsSync(cancelOut))

// ── 汇总 ────────────────────────────────────────────
console.log(`\n${line('═')}`)
if (failures === 0) {
  console.log(`全部校验通过\n输出文件：${outputPath}\n`)
} else {
  console.log(`${failures} 项校验失败\n`)
  process.exit(1)
}
