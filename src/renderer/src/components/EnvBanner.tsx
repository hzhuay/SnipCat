import type { EnvStatus } from '@shared/types'

/**
 * ffmpeg 缺失时的顶部提示条。
 *
 * 按方案约定不打包 ffmpeg，所以环境缺失是需要用户处理的正常情况，
 * 给出平台对应的安装命令而不是只说"未找到"。
 */
export function EnvBanner({
  env,
  onRecheck,
}: {
  env: EnvStatus | null
  onRecheck: () => void
}) {
  if (!env) return null
  if (env.ffmpeg && env.ffprobe) return null

  const missing = [!env.ffmpeg && 'ffmpeg', !env.ffprobe && 'ffprobe'].filter(Boolean)
  const isWin = navigator.userAgent.includes('Windows')

  return (
    <div className="env-banner">
      <span>⚠︎</span>
      <div style={{ flex: 1 }}>
        未在 PATH 中找到 {missing.join(' 和 ')}。请先安装后再使用。
        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
          {isWin ? (
            <>
              Windows：<code>winget install Gyan.FFmpeg</code> 或从 gyan.dev 下载后把
              bin 目录加入 PATH
            </>
          ) : (
            <>
              macOS：<code>brew install ffmpeg</code>
            </>
          )}
        </div>
      </div>
      <button onClick={onRecheck}>重新检测</button>
    </div>
  )
}
