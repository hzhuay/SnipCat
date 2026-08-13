/**
 * ffmpeg / ffprobe 可执行文件的定位。
 *
 * 按方案约定只从 PATH 取，不打包内置、不做回退 —— 由用户保证环境里有。
 * 这里是全应用唯一的路径来源：将来若要改成内置 ffmpeg-static，只需改这一个文件。
 */

import { spawn } from 'node:child_process'
import type { EnvStatus } from '@shared/types'

/** 从 PATH 里找可执行文件。Windows 用 where，其余用 which。 */
function findInPath(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const child = spawn(finder, [name], { shell: false })
    let out = ''

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      // where 可能返回多行，取第一条
      const first = out.split(/\r?\n/).find((l) => l.trim() !== '')
      resolve(first ? first.trim() : null)
    })
  })
}

/** 读取 `ffmpeg -version` 的首行，用于在 UI 上显示版本 */
function readVersion(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['-version'], { shell: false })
    let out = ''

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.on('error', () => resolve(undefined))
    child.on('close', () => {
      const first = out.split(/\r?\n/)[0]?.trim()
      resolve(first || undefined)
    })
  })
}

let cached: EnvStatus | null = null

/**
 * 探测环境。结果缓存，避免每次操作都 spawn 两个进程。
 *
 * @param force 忽略缓存重新探测（用户装好 ffmpeg 后点"重新检测"时用）
 */
export async function locateBinaries(force = false): Promise<EnvStatus> {
  if (cached && !force) return cached

  const [ffmpeg, ffprobe] = await Promise.all([findInPath('ffmpeg'), findInPath('ffprobe')])
  const version = ffmpeg ? await readVersion(ffmpeg) : undefined

  cached = { ffmpeg, ffprobe, version }
  return cached
}

/**
 * 取可用的二进制路径，缺失时抛出带指引的错误。
 *
 * 抛错而不是返回 null：调用方（probe / job）在没有 ffmpeg 时无法继续，
 * 让错误信息直接冒泡到 UI 比层层判空更清楚。
 */
export async function requireBinaries(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const env = await locateBinaries()
  const missing: string[] = []
  if (!env.ffmpeg) missing.push('ffmpeg')
  if (!env.ffprobe) missing.push('ffprobe')

  if (missing.length > 0) {
    throw new Error(
      `未在 PATH 中找到 ${missing.join(' 和 ')}。请先安装 ffmpeg 并确保命令行可直接调用。`
    )
  }

  return { ffmpeg: env.ffmpeg as string, ffprobe: env.ffprobe as string }
}

/** 清空缓存，用于"重新检测"按钮 */
export function invalidateEnvCache(): void {
  cached = null
  encoderSupport = null
}

/** 编码器可用性（是否内置 av1_amf 等），带缓存 */
let encoderSupport: Record<string, boolean> | null = null

/**
 * 探测 ffmpeg 内置了哪些压缩编码器。
 *
 * 只读 `ffmpeg -encoders` 的输出（约 100ms），不初始化 GPU —— 编码器出现在
 * 列表里不代表驱动一定能跑（如核显 RDNA2 就编不了 AV1），真正失败会在编码时
 * 报错并显示在日志里。UI 用它来决定「硬件编码」选项是否可选。
 */
export async function detectEncoderSupport(force = false): Promise<Record<string, boolean>> {
  if (encoderSupport && !force) return encoderSupport

  const support: Record<string, boolean> = { amf: false }
  try {
    const { ffmpeg } = await requireBinaries()
    const out = await new Promise<string>((resolve) => {
      const child = spawn(ffmpeg, ['-hide_banner', '-encoders'], { shell: false })
      let s = ''
      child.stdout.on('data', (d: Buffer) => (s += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (s += d.toString('utf8')))
      child.on('error', () => resolve(''))
      child.on('close', () => resolve(s))
    })
    support.amf = /\bav1_amf\b/.test(out)
  } catch {
    // 探测失败按不支持处理
  }
  encoderSupport = support
  return support
}
