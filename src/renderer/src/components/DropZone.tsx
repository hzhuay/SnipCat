/**
 * 选择视频的入口（点击）。
 *
 * 拖放不再限制在这个区域 —— 整个页面都能接受拖入文件，见 App.tsx 的
 * handleDrop（用 window.api.pathForFile 拿磁盘路径，这是选 Electron 的核心原因）。
 * 这里只保留「点击选择」和一句引导提示。
 *
 * 刻意不因为 ffmpeg 缺失就禁用：那会让点击静默无反应。选文件本身不需要 ffmpeg，
 * 后续读元数据失败时会给出明确的错误信息。
 */
export function DropZone({
  hasFile,
  disabled,
  onPick,
}: {
  hasFile: boolean
  disabled: boolean
  onPick: () => void
}) {
  const cls = ['dropzone', 'compact', disabled ? 'disabled' : ''].filter(Boolean).join(' ')

  return (
    <div className={cls} onClick={() => !disabled && onPick()}>
      <span>{hasFile ? '已加载视频，点击可重新选择' : '选择视频文件'}</span>
      <span className="dropzone-hint">也可把视频拖到窗口任意位置</span>
    </div>
  )
}
