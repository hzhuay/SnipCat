/**
 * 打印 ffmpeg 命令，不需要安装 ffmpeg。
 *
 * 用途：在没有 ffmpeg 的机器上（比如 mac 开发机）人工 review 将要执行的命令。
 * 用的是与 GUI 完全相同的 buildJobCommands，所以这里打印的就是实际会跑的命令。
 *
 * 用法（都从项目根目录运行）：
 *   npm run commands                 # 内置的 h264 mp4 示例
 *   npm run commands -- --mkv        # 4K HEVC 多轨 mkv 示例（路径含空格和单引号）
 *   npm run commands -- --compress   # 压缩模式（AV1 重编码）
 *   npm run commands -- --single     # 只有一段（验证跳过 concat 的分支）
 *   npm run commands -- --probe=path/to/ffprobe-output.json --file=D:/v/a.mp4
 *                                    # 用真实的 ffprobe 输出（Windows 上可先重定向到文件）
 */

import { readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { buildJobCommands, buildOutputPath, renderCommandLine } from '../src/shared/commands.ts'
import { parseProbeOutput } from '../src/shared/probe.ts'
import { parseTime, formatTime, formatCompact, formatOffset } from '../src/shared/time.ts'
import { resolveExecutableSegments, validateSegments } from '../src/shared/validate.ts'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const valueOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const mode = has('--compress') ? 'compress' : 'copy'
const single = has('--single')

/** 内置示例，路径是虚构的 —— 只用于构造命令，不会真的读这些视频 */
const BUILTIN = {
  mp4: {
    probe: 'test/fixtures/probe-h264-aac.json',
    file: '/Users/zhuhuanqi/videos/demo.mp4',
  },
  mkv: {
    probe: 'test/fixtures/probe-hevc-multitrack.json',
    file: "/Users/zhuhuanqi/videos/4k clip's.mkv",
  },
}

const builtin = has('--mkv') ? BUILTIN.mkv : BUILTIN.mp4
// 相对路径按项目根目录（cwd）解析，这样从 npm script 跑时不受打包位置影响
const probePath = resolve(process.cwd(), valueOf('probe') ?? builtin.probe)
const videoPath = (valueOf('file') ?? builtin.file).replace(/\\/g, '/')

const ext = extname(videoPath)
const meta = parseProbeOutput(readFileSync(probePath, 'utf8'), {
  path: videoPath,
  dir: videoPath.slice(0, videoPath.lastIndexOf('/')) || '.',
  base: basename(videoPath, ext),
  ext,
})

/** 示例时间段，格式故意混用来体现宽松解析 */
const rawSegments = single
  ? [['00:00:13', '00:01:30']]
  : [
      ['00:00:13', '00:01:30'],
      ['2:00', '2:45'],
      ['90.5', '100'],
    ]

/**
 * 模拟关键帧吸附：假设每 2 秒一个关键帧。
 * 真实吸附靠 ffprobe 探测实际关键帧位置，这里只是让输出里的 -ss
 * 呈现出偏移的效果，便于确认命令形态和偏移展示逻辑。
 */
const GOP_SEC = 2
const fakeSnap = (t) => Math.floor(t / GOP_SEC) * GOP_SEC

const edited = rawSegments.map(([s, e], i) => ({
  id: `seg-${i}`,
  startRaw: s,
  endRaw: e,
  startSec: parseTime(s),
  endSec: parseTime(e),
}))

// 走与 GUI 完全相同的校验 + 筛选路径，否则会构造出 GUI 根本不会执行的命令
const validation = validateSegments(edited, meta)
const executable = resolveExecutableSegments(edited, meta).map((s) => ({
  ...s,
  snappedStartSec: mode === 'copy' ? fakeSnap(s.startSec) : undefined,
}))

const outputPath = buildOutputPath(meta, '_cut')

const line = '─'.repeat(78)

console.log(`\n输入   ${meta.path}`)
console.log(
  `       ${meta.streams[0].codecName} ${meta.streams[0].width}×${meta.streams[0].height} · 时长 ${formatTime(meta.durationSec)}`
)
console.log(`模式   ${mode === 'copy' ? '流复制（无损，切点吸附关键帧）' : '压缩（AV1 重编码）'}`)
console.log(`输出   ${outputPath}`)
console.log(`\n${line}\n时间段`)

for (const [i, s] of edited.entries()) {
  const kept = executable.find((x) => x.id === s.id)
  const issues = validation.issues.filter((it) => it.segmentId === s.id)
  const err = issues.find((it) => it.level === 'error')
  const warn = issues.find((it) => it.level === 'warning')

  let note
  if (err) {
    note = `✗ ${err.message}`
  } else if (!kept) {
    note = '（已跳过：不构成有效片段）'
  } else {
    const actual = kept.snappedStartSec ?? kept.startSec
    const delta = actual - kept.startSec
    note =
      mode === 'copy'
        ? Math.abs(delta) > 0.1
          ? `实际 ${formatTime(actual)}  ⚠︎ 偏移 ${formatOffset(delta)}`
          : `实际 ${formatTime(actual)}  ✓`
        : '帧级精确（重编码）'
    if (warn) note += `   ⚠︎ ${warn.message}`
  }

  const dur = kept ? formatCompact(kept.endSec - (kept.snappedStartSec ?? kept.startSec)) : ''
  console.log(
    `  #${i + 1}  ${s.startRaw.padEnd(10)} → ${s.endRaw.padEnd(10)} ${dur.padStart(6)}   ${note}`
  )
}

if (executable.length === 0) {
  console.log('\n没有可执行的片段，GUI 会禁用「开始处理」按钮。\n')
  process.exit(0)
}

const plan = buildJobCommands(meta, executable, mode, outputPath, '/tmp/videocut-XXXXXX')

console.log(`\n共 ${executable.length} 段 / ${formatCompact(plan.totalDurationSec)}`)

if (mode === 'copy') {
  console.log(
    '\n注：上面的吸附结果是按「每 2 秒一个关键帧」模拟的，仅用于展示偏移的呈现方式。' +
      '\n    真实吸附由 ffprobe 探测实际关键帧位置得出。'
  )
}

console.log(`\n${line}\n将要执行的命令（${plan.commands.length} 条）\n`)

for (const cmd of plan.commands) {
  console.log(`# ${cmd.label}`)
  console.log(renderCommandLine(cmd))
  console.log()
}

if (plan.needsConcat) {
  console.log(`${line}\nconcat 列表文件 ${plan.listPath}\n`)
  console.log(plan.listContent)
} else {
  console.log(`${line}`)
  console.log(`只有一段，跳过 concat，直接把 ${plan.stagedOutput} 重命名为输出文件\n`)
}
