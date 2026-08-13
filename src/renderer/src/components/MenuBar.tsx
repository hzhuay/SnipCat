/** 菜单栏视图：主流程 / 后台任务 / 日志（后续功能在这里扩展） */
export type View = 'workflow' | 'tasks' | 'logs'

const MENU: Array<{ key: View; label: string }> = [
  { key: 'workflow', label: '编辑' },
  { key: 'tasks', label: '后台任务' },
  { key: 'logs', label: '日志' },
]

/**
 * 顶部菜单栏：收纳后台任务、日志等支撑性功能，主页面只留核心编辑流程。
 * 后台任务项带活跃任务数徽标。
 */
export function MenuBar({
  view,
  activeTaskCount,
  onSelect,
}: {
  view: View
  activeTaskCount: number
  onSelect: (v: View) => void
}) {
  return (
    <div className="menu-bar">
      <span className="menu-brand" onClick={() => onSelect('workflow')}>
        SnipCat
      </span>
      {MENU.map((m) => (
        <button
          key={m.key}
          className={`menu-item${view === m.key ? ' active' : ''}`}
          onClick={() => onSelect(m.key)}
        >
          {m.label}
          {m.key === 'tasks' && activeTaskCount > 0 && (
            <span className="menu-badge">{activeTaskCount}</span>
          )}
        </button>
      ))}
    </div>
  )
}
