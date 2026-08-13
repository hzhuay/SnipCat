import type { CompressEncoder, CutMode, VideoMeta } from '@shared/types'
import { DEFAULT_SUFFIX } from '@shared/types'
import { checkCompressModeSupport } from '@shared/commands'

interface Props {
  meta: VideoMeta
  suffix: string
  outputPath: string
  mode: CutMode
  encoder: CompressEncoder
  /** 硬件编码器是否可用（ffmpeg 内置 av1_amf） */
  amfAvailable: boolean
  dryRun: boolean
  disabled: boolean
  onSuffixChange: (v: string) => void
  onModeChange: (m: CutMode) => void
  onEncoderChange: (enc: CompressEncoder) => void
  onDryRunChange: (v: boolean) => void
}

/** 输出文件名、切分模式、Dry-run 开关 */
export function OutputPanel(p: Props) {
  const compress = checkCompressModeSupport(p.meta)
  const suffixEmpty = p.suffix.trim() === ''

  return (
    <div className="panel">
      <div className="panel-title">输出</div>

      <div className="row">
        <span className="mono">{p.meta.base}</span>
        <input
          type="text"
          className="mono"
          style={{ width: 120 }}
          value={p.suffix}
          disabled={p.disabled}
          onChange={(e) => p.onSuffixChange(e.target.value)}
          placeholder={DEFAULT_SUFFIX[p.mode]}
        />
        <span className="mono">{p.meta.ext}</span>
        {suffixEmpty && <span style={{ color: 'var(--error)' }}>后缀不能为空（会覆盖原视频）</span>}
      </div>

      <div className="out-path">{p.outputPath}</div>

      <div className="panel-title" style={{ marginTop: 16 }}>
        切分模式
      </div>
      <div className="mode-list">
        <label className="mode-option">
          <input
            type="radio"
            checked={p.mode === 'copy'}
            disabled={p.disabled}
            onChange={() => p.onModeChange('copy')}
          />
          <span>
            流复制（推荐）
            <div className="mode-desc">
              编码参数与原视频完全一致、零画质损失、几秒完成。切点会吸附到最近的关键帧，
              实际时间与输入可能有偏差，列表中会标出。
            </div>
          </span>
        </label>

        <label className={`mode-option${compress.ok ? '' : ' disabled'}`}>
          <input
            type="radio"
            checked={p.mode === 'compress'}
            disabled={p.disabled || !compress.ok}
            onChange={() => p.onModeChange('compress')}
          />
          <span>
            压缩
            <div className="mode-desc">
              {compress.ok ? (
                <>
                  用 <strong>AV1</strong> 编码器重新编码画面（音频保持原样不重编码），
                  同画质下体积明显更小，但会<strong>重新编码一次</strong>、有画质损失。
                  压缩任务<strong>进入后台队列</strong>执行（同队列 FIFO），可随时发流复制；
                  流复制会临时暂停后台压缩、完成后自动继续。AV1 编码较慢，长视频以
                  分钟计；播放需要设备/播放器支持 AV1 硬解或软解。
                </>
              ) : (
                compress.reason
              )}
            </div>
          </span>
        </label>
      </div>

      {p.mode === 'compress' && (
        <div style={{ marginTop: 14 }}>
          <div className="panel-title" style={{ marginBottom: 6 }}>
            编码器
          </div>
          <div className="mode-list">
            <label className="mode-option">
              <input
                type="radio"
                checked={p.encoder === 'svtav1'}
                disabled={p.disabled}
                onChange={() => p.onEncoderChange('svtav1')}
              />
              <span>
                软件 AV1（SVT-AV1）
                <div className="mode-desc">
                  纯 CPU 编码，同画质体积最小，但较慢（1 小时视频约 10~20 分钟）。
                </div>
              </span>
            </label>

            <label className={`mode-option${p.amfAvailable ? '' : ' disabled'}`}>
              <input
                type="radio"
                checked={p.encoder === 'amf'}
                disabled={p.disabled || !p.amfAvailable}
                onChange={() => p.onEncoderChange('amf')}
              />
              <span>
                硬件 AV1（AMD AMF）
                <div className="mode-desc">
                  用独显（如 RX 7900 GRE）硬编，快 10~30 倍，1 小时视频约 1~3 分钟；
                  同画质体积略大。{' '}
                  {p.amfAvailable
                    ? ''
                    : '当前 ffmpeg 未检测到 av1_amf 编码器，此项不可用。'}
                </div>
              </span>
            </label>
          </div>
        </div>
      )}

      <label className="row" style={{ cursor: 'pointer', marginTop: 14 }}>
        <input
          type="checkbox"
          checked={p.dryRun}
          disabled={p.disabled}
          onChange={(e) => p.onDryRunChange(e.target.checked)}
        />
        <span>
          只输出命令不执行（Dry-run）
          <span className="dim"> — 查看将要运行的 ffmpeg 命令</span>
        </span>
      </label>
    </div>
  )
}
