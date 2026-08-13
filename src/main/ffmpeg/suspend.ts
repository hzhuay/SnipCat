/**
 * 进程挂起 / 恢复（Windows）。
 *
 * Node 的 child.kill 不支持 SIGSTOP/SIGCONT，Windows 上也没有原生的命令行
 * 挂起工具，所以用 PowerShell 调 ntdll 的 NtSuspendProcess / NtResumeProcess
 * 实现。每次调用是一次性的 powershell 进程，只在「前台抢占后台」的边界触发
 * （频率极低），1~2s 的启动开销可以接受。
 *
 * 挂起/恢复都是尽力而为：目标进程已退出、PowerShell 不可用等情况都静默降级，
 * 不阻塞主流程（调度器另有兜底，最坏结果是前后台短暂并发）。
 */

import { execFile } from 'node:child_process'

/** 是否支持挂起（仅 Windows；其它平台调用返回 no-op） */
export function isSuspendSupported(): boolean {
  return process.platform === 'win32'
}

// OpenProcess 用 PROCESS_SUSPEND_RESUME(0x0800) 打开句柄即可满足挂起/恢复权限。
// Get-Process 返回的 .Handle 默认没有该权限，所以显式 OpenProcess。
function psScript(pid: number, action: 'Suspend' | 'Resume'): string {
  const call = action === 'Suspend' ? 'NtSuspendProcess' : 'NtResumeProcess'
  return `
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($null -eq $p) { exit 0 }
$sig = '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);'
Add-Type -MemberDefinition $sig -Name Nt -Namespace W -ErrorAction SilentlyContinue
$h = [W.Nt]::OpenProcess(0x0800, $false, $p.Id)
if ($h -ne [IntPtr]::Zero) {
  [W.Nt]::${call}($h) | Out-Null
  [W.Nt]::CloseHandle($h) | Out-Null
}
`
}

function runPs(pid: number, action: 'Suspend' | 'Resume'): Promise<void> {
  if (!isSuspendSupported()) return Promise.resolve()
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript(pid, action)],
      () => resolve() // 任何错误都静默降级，不阻断调度
    )
  })
}

export function suspendPid(pid: number): Promise<void> {
  return runPs(pid, 'Suspend')
}

export function resumePid(pid: number): Promise<void> {
  return runPs(pid, 'Resume')
}
