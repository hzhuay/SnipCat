/**
 * 测试辅助：从固化的 ffprobe fixture 构造 VideoMeta。
 *
 * 单独放一个文件（而不是从某个 .test.ts 里 export）是为了避免
 * 跨测试文件 import 时把对方的 describe 块重复注册。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProbeOutput } from '../src/shared/probe'
import type { Segment, VideoMeta } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

function loadMeta(
  file: string,
  pathInfo: { path: string; dir: string; base: string; ext: string }
): VideoMeta {
  return parseProbeOutput(readFileSync(join(FIXTURES, file), 'utf8'), pathInfo)
}

/** 典型的 h264 High@4.0 + aac 立体声 mp4，时长 624.557267s ≈ 10:24.56 */
export function h264Meta(): VideoMeta {
  return loadMeta('probe-h264-aac.json', {
    path: '/Users/zhuhuanqi/videos/demo.mp4',
    dir: '/Users/zhuhuanqi/videos',
    base: 'demo',
    ext: '.mp4',
  })
}

/** 4K HEVC 10bit mkv，双音轨 + 字幕轨 + data 轨，文件名含空格和单引号 */
export function hevcMeta(): VideoMeta {
  return loadMeta('probe-hevc-multitrack.json', {
    path: "/Users/zhuhuanqi/videos/4k clip's.mkv",
    dir: '/Users/zhuhuanqi/videos',
    base: "4k clip's",
    ext: '.mkv',
  })
}

/** 按秒数直接造段落，可选传入吸附后的起点/终点 */
export function seg(
  startSec: number,
  endSec: number,
  snappedStartSec?: number,
  snappedEndSec?: number
): Segment {
  return {
    id: `s${startSec}`,
    startRaw: String(startSec),
    endRaw: String(endSec),
    startSec,
    endSec,
    snappedStartSec,
    snappedEndSec,
  }
}

/** 取 argv 中某个 flag 紧随其后的值 */
export function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
