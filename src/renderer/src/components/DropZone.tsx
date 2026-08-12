import { useState, type DragEvent } from 'react'

/**
 * 文件拖放区 + 选择按钮。
 *
 * 拖拽拿真实路径靠 window.api.pathForFile（Electron 的 webUtils.getPathForFile）——
 * 浏览器 File API 拿不到磁盘路径，这是选 Electron 的核心原因。
 *
 * 刻意不因为 ffmpeg 缺失就禁用：那会让点击静默无反应。选文件本身不需要 ffmpeg，
 * 后续读元数据失败时会给出明确的错误信息。
 */
export function DropZone({
  hasFile,
  disabled,
  onPick,
  onDropFile,
}: {
  hasFile: boolean
  disabled: boolean
  onPick: () => void
  onDropFile: (path: string) => void
}) {
  const [over, setOver] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (disabled) return

    const file = e.dataTransfer.files[0]
    if (!file) {
      setDropError('没有识别到文件，请直接拖入一个视频文件')
      return
    }

    const path = window.api.pathForFile(file)
    if (!path) {
      // 拖入的可能不是真实磁盘文件（如浏览器里的图片、压缩包内的条目）
      setDropError(`无法获取「${file.name}」的磁盘路径，请改用「选择文件」`)
      return
    }

    setDropError(null)
    onDropFile(path)
  }

  const cls = ['dropzone', over ? 'over' : '', hasFile ? 'compact' : '', disabled ? 'disabled' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <div
        className={cls}
        onClick={() => !disabled && onPick()}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
      >
        {hasFile ? (
          <span className="dropzone-hint">拖入另一个视频，或点击重新选择</span>
        ) : (
          <>
            <span style={{ fontSize: 22 }}>↙</span>
            <span>拖拽视频到此处</span>
            <span className="dropzone-hint">或点击选择文件</span>
          </>
        )}
      </div>

      {dropError && (
        <div className="panel">
          <span className="status-error">✗ </span>
          <span>{dropError}</span>
        </div>
      )}
    </>
  )
}
