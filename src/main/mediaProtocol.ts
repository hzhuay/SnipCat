/**
 * 本地视频文件的自定义协议。
 *
 * 渲染进程的 <video> 不能直接用 file:// —— webSecurity 会拦，而关掉
 * webSecurity 不可接受。这里注册 media:// 协议把请求映射到文件流。
 *
 * 关键的两点：
 *  1. 路径白名单：只允许读用户显式选择过的文件，防止渲染进程借这个协议任意读盘
 *  2. Range 支持：播放器拖动进度条依赖 206 响应，不支持 Range 就无法 seek
 */

import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'

export const MEDIA_SCHEME = 'media'

/** 用户显式选择过的文件路径白名单 */
const allowed = new Set<string>()

export function allowMediaPath(p: string): void {
  allowed.add(p)
}

/** 生成渲染进程可用的 URL */
export function toMediaUrl(p: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(p)}`
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
}

/**
 * 必须在 app ready 之前调用：声明该协议支持流式响应和 Range 请求。
 */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

/** 在 app ready 之后调用，挂上真正的处理函数 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))

    if (!allowed.has(filePath)) {
      return new Response('Forbidden', { status: 403 })
    }

    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      return new Response('Not Found', { status: 404 })
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const range = request.headers.get('Range')

    // 无 Range：整文件响应，但仍要声明 accept-ranges，否则播放器不会尝试 seek
    if (!range) {
      const stream = createReadStream(filePath)
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
        },
      })
    }

    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (!m) {
      return new Response('Bad Range', { status: 416 })
    }

    let start = m[1] === '' ? 0 : Number(m[1])
    let end = m[2] === '' ? size - 1 : Number(m[2])

    // 形如 `bytes=-500`：请求最后 500 字节
    if (m[1] === '' && m[2] !== '') {
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }
    end = Math.min(end, size - 1)

    const stream = createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    })
  })
}
