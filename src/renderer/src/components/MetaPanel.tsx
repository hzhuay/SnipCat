import type { VideoMeta } from '@shared/types'
import { describeMeta, formatBytes } from '@shared/probe'
import { formatTime } from '@shared/time'

/** 输入视频的元数据摘要 */
export function MetaPanel({ meta }: { meta: VideoMeta }) {
  const lines = describeMeta(meta)
  const container = meta.ext.replace(/^\./, '') || meta.formatName

  return (
    <div className="panel">
      <div className="meta-name">{meta.base + meta.ext}</div>
      {lines.map((l, i) => (
        <div className="meta-line" key={i}>
          {l}
        </div>
      ))}
      <div className="meta-line" style={{ marginTop: 4 }}>
        时长 {formatTime(meta.durationSec)} · {formatBytes(meta.sizeBytes)} · {container}
      </div>
      <div className="meta-line dim" style={{ marginTop: 6, opacity: 0.7 }}>
        {meta.dir}
      </div>
    </div>
  )
}
