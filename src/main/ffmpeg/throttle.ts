/**
 * 进程优先级降级 / 恢复（节流）。
 *
 * 通过降低 OS 进程优先级实现「软暂停」—— ffmpeg 仍在运行、文件安全，但
 * 几乎吃不到 CPU（对打游戏不抢资源，手动暂停也不影响正在写入的输出文件）。
 *
 * Windows: SetPriorityClass (IDLE_PRIORITY_CLASS = 0x40 / NORMAL = 0x20)
 * macOS/Linux: renice -n 20（对已运行进程改优先级）
 *
 * 这是尽力而为的操作：pid 不存在等情况静默降级，不抛异常。
 */

import { execFile } from 'node:child_process'

// ─── Windows ───────────────────────────────────────────────

const IDLE_PRIORITY_CLASS = 0x40
const NORMAL_PRIORITY_CLASS = 0x20

// OpenProcess 用 PROCESS_SET_INFORMATION(0x200) 即可满足 SetPriorityClass 权限。
function psScript(pid: number, action: 'throttle' | 'restore'): string {
  const prio = action === 'throttle' ? IDLE_PRIORITY_CLASS : NORMAL_PRIORITY_CLASS
  return `
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($null -eq $p) { exit 0 }
$sig = '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); [DllImport("kernel32.dll")] public static extern bool SetPriorityClass(IntPtr h, uint dwPriorityClass);'
Add-Type -MemberDefinition $sig -Name Nt -Namespace W -ErrorAction SilentlyContinue
$h = [W.Nt]::OpenProcess(0x0200, $false, $p.Id)
if ($h -ne [IntPtr]::Zero) {
  [W.Nt]::SetPriorityClass($h, ${prio}) | Out-Null
  [W.Nt]::CloseHandle($h) | Out-Null
}
`
}

function winSetPriority(pid: number, action: 'throttle' | 'restore'): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript(pid, action)],
      () => resolve() // 任何错误都静默降级，不阻断调度
    )
  })
}

// ─── macOS / Linux ─────────────────────────────────────────

// renice 调整已运行进程的 nice 值：20 = 最低优先级（几乎不抢 CPU），0 = 默认。
function renice(pid: number, nice: number): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'renice',
      ['-n', String(nice), '-p', String(pid)],
      { shell: false },
      () => resolve()
    )
  })
}

function unixSetPriority(pid: number, action: 'throttle' | 'restore'): Promise<void> {
  return renice(pid, action === 'throttle' ? 20 : 0)
}

// ─── 公共 API ──────────────────────────────────────────────

export function throttlePid(pid: number): Promise<void> {
  if (process.platform === 'win32') return winSetPriority(pid, 'throttle')
  return unixSetPriority(pid, 'throttle')
}

export function unthrottlePid(pid: number): Promise<void> {
  if (process.platform === 'win32') return winSetPriority(pid, 'restore')
  return unixSetPriority(pid, 'restore')
}
