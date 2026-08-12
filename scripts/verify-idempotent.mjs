/**
 * 吸附幂等性的真实验证：跑真的 ffmpeg/ffprobe，不用 mock。
 *
 * 复现用户报告的 bug：把界面显示的吸附结果输回输入框，吸附结果不该再变。
 * 单测只能验证取整逻辑，这里验证的是「取整方向与 ffmpeg 实际 seek 行为匹配」。
 *
 * 用法：node out/tools/verify-idempotent.mjs <视频路径>...
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { probeVideo } from '../src/main/ffmpeg/probe.ts'
import { snapSegments } from '../src/main/ffmpeg/keyframes.ts'
import { snapDisplay } from '../src/shared/interaction.ts'
import { formatTime, parseTime } from '../src/shared/time.ts'
import { frameDuration } from '../src/shared/video.ts'

const files = process.argv.slice(2).map((p) => resolve(p))
if (files.length === 0) {
  console.error('用法: node verify-idempotent.mjs <视频路径>...')
  process.exit(1)
}

let failures = 0
function check(label, ok, detail = '') {
  console.log(`    ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

/** 走一遍「吸附 → 取整显示 → 用户把显示值输回去」的完整往返 */
async function roundTrip(meta, startSec, endSec) {
  const [snap] = await snapSegments(meta.path, [[startSec, endSec]], meta.durationSec)
  const seg = {
    id: 'x',
    startRaw: formatTime(startSec),
    endRaw: formatTime(endSec),
    startSec,
    endSec,
    snappedStartSec: snap.startSec,
    snappedEndSec: snap.endSec,
  }
  const display = snapDisplay(seg, frameDuration(meta))
  return { snap, display }
}

for (const file of files) {
  if (!existsSync(file)) {
    console.error(`跳过：找不到 ${file}`)
    continue
  }

  const meta = await probeVideo(file)
  const fps = 1 / frameDuration(meta)
  console.log(`\n${'═'.repeat(74)}`)
  console.log(`${meta.base}${meta.ext}  ${fps.toFixed(2)}fps  时长 ${formatTime(meta.durationSec)}`)

  // 挑几个刻意不在关键帧上的时间点
  const cases = [
    [9.88, 15.4],
    [3.317, 7.923],
    [1.5, 4.5],
  ].filter(([s, e]) => e < meta.durationSec)

  for (const [startSec, endSec] of cases) {
    console.log(`\n  输入 ${formatTime(startSec)} → ${formatTime(endSec)}`)

    const r1 = await roundTrip(meta, startSec, endSec)
    if (!r1.display) {
      console.log('    （无吸附结果，跳过）')
      continue
    }
    console.log(
      `    第 1 轮  真实落点 ${r1.snap.startSec.toFixed(6)} → ${r1.snap.endSec.toFixed(6)}`
    )
    console.log(
      `             界面显示 ${formatTime(r1.display.startSec)} → ${formatTime(r1.display.endSec)}` +
        `   多切 头 +${r1.display.headExtra.toFixed(3)}s / 尾 +${r1.display.tailExtra.toFixed(3)}s`
    )

    // 关键：把界面显示的值当作新输入（模拟用户手动输入显示值）
    const back = {
      start: parseTime(formatTime(r1.display.startSec)),
      end: parseTime(formatTime(r1.display.endSec)),
    }
    const r2 = await roundTrip(meta, back.start, back.end)
    console.log(
      `    第 2 轮  真实落点 ${r2.snap.startSec.toFixed(6)} → ${r2.snap.endSec.toFixed(6)}`
    )
    console.log(
      `             界面显示 ${formatTime(r2.display.startSec)} → ${formatTime(r2.display.endSec)}` +
        `   多切 头 +${r2.display.headExtra.toFixed(3)}s / 尾 +${r2.display.tailExtra.toFixed(3)}s`
    )

    // 幂等的核心断言：第二轮的落点必须与第一轮相同，不能再往外跳
    check(
      '落点幂等（起点未再向前跳）',
      Math.abs(r2.snap.startSec - r1.snap.startSec) < 1e-6,
      `${r1.snap.startSec.toFixed(6)} → ${r2.snap.startSec.toFixed(6)}`
    )
    check(
      '落点幂等（终点未再向后跳）',
      Math.abs(r2.snap.endSec - r1.snap.endSec) < 1e-6,
      `${r1.snap.endSec.toFixed(6)} → ${r2.snap.endSec.toFixed(6)}`
    )
    check(
      '显示值幂等（第 2 轮显示与输入一致）',
      // 比格式化后的字符串，不比浮点数 —— 界面上呈现的就是这个字符串，
      // 而 1.001+0.001 在浮点里是 1.0020000000000002，严格相等会假失败
      formatTime(r2.display.startSec) === formatTime(back.start) &&
        formatTime(r2.display.endSec) === formatTime(back.end)
    )
    check('第 2 轮不再提示多切', !r2.display.drifted)

    // 第三轮：确认稳定，不是恰好震荡到一致
    const r3 = await roundTrip(
      meta,
      parseTime(formatTime(r2.display.startSec)),
      parseTime(formatTime(r2.display.endSec))
    )
    check(
      '第 3 轮仍然稳定',
      Math.abs(r3.snap.startSec - r2.snap.startSec) < 1e-6 &&
        Math.abs(r3.snap.endSec - r2.snap.endSec) < 1e-6
    )

    // 方向正确性：两端都必须向外，任何一端向内都意味着丢内容
    check('起点未晚于输入（不丢头）', r1.snap.startSec <= startSec + 1e-6)
    check('终点未早于输入（不丢尾）', r1.snap.endSec >= endSec - 1e-6)
  }
}

console.log(`\n${'═'.repeat(74)}`)
if (failures === 0) {
  console.log('吸附幂等性校验全部通过\n')
} else {
  console.log(`${failures} 项校验失败\n`)
  process.exit(1)
}
