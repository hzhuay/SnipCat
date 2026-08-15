/**
 * 游戏检测：用户开始打游戏时自动降级所有后台压缩任务（释放 CPU），退出游戏后恢复。
 *
 * 原理：轮询当前前台窗口所属的进程名（Windows: GetForegroundWindow + 进程名；
 * macOS/Linux 暂不支持——前台窗口检测无跨平台标准 API，Windows 是主战场）。
 * 命中已知游戏进程名则通知调度器 setGameActive(true)，否则 false。
 *
 * 轮询间隔 2s：游戏进程名判断本身足够便宜，但每次要起一个 powershell，
 * 间隔太短会持续占用几百 KB 常驻，2s 是「响应够快 + 开销可忽略」的折中。
 */

import { execFile } from 'node:child_process'
import { logInfo } from './log'
import type { JobScheduler } from './ffmpeg/scheduler'

/** 视为「在打游戏」的前台进程名（不含 .exe，全小写）。可继续补充。 */
const GAME_PROCESSES = new Set([
  // 主流游戏平台启动器
  'steam',
  'epicgameslauncher',
  'egs',
  'goggalaxy',
  'playnite',
  // 常见大型单机/联机游戏
  'eldenring',
  'starfield',
  'cyberpunk2077',
  'gta5',
  'gtav',
  'rdr2',
  'reddead2',
  'valorant',
  'leagueclient',
  'leagueoflegends',
  'dota2',
  'csgo',
  'cs2',
  'overwatch',
  'apexlegends',
  'r5apex',
  'fortnite',
  'minecraft',
  'rust',
  'factorio',
  'satisfactory',
  'witcher3',
  'witcher3_cn',
])

// ─── Windows 前台窗口进程名 ───────────────────────────────

/**
 * 取前台窗口的 { 进程名, 是否全屏 }。
 *
 * 全屏判断：前台窗口矩形是否覆盖其所在显示器的完整区域（含任务栏区域，
 * 容差 8px）。独占全屏/无边框全屏游戏会覆盖；普通窗口、最大化窗口（不含
 * 任务栏）不会。用 System.Windows.Forms.Screen 拿显示器尺寸，避免手写
 * MONITORINFO 结构体。
 */
function psScript(): string {
  return `
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$src = @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class SnipCatWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
}
'@
Add-Type -TypeDefinition $src -Language CSharp -ErrorAction SilentlyContinue
$h = [SnipCatWin]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { Write-Output 'no_focus'; exit 0 }
$pid2 = [UInt32]::new()
[SnipCatWin]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
if ($pid2 -eq 0) { exit 0 }
$p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
if ($null -eq $p) { exit 0 }
$rect = New-Object RECT
[SnipCatWin]::GetWindowRect($h, [ref]$rect) | Out-Null
$scr = [System.Windows.Forms.Screen]::FromHandle($h)
$w = $rect.Right - $rect.Left
$hh = $rect.Bottom - $rect.Top
$mw = $scr.Bounds.Width
$mh = $scr.Bounds.Height
$fullscreen = ($w -ge $mw - 8) -and ($hh -ge $mh - 8)
Write-Output ("{0}|{1}" -f $p.ProcessName, $fullscreen)
`
}

/** 前台窗口信息：进程名 + 是否全屏。失败返回 null。 */
export interface FrontWindowInfo {
  processName: string
  fullscreen: boolean
}

function getFrontWindow(): Promise<FrontWindowInfo | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript()],
      { shell: false, windowsHide: true },
      (_err, stdout) => {
        const line = stdout.trim()
        if (!line || line === 'no_focus') {
          resolve(null)
          return
        }
        const sep = line.lastIndexOf('|')
        if (sep < 0) {
          resolve(null)
          return
        }
        resolve({
          processName: line.slice(0, sep),
          fullscreen: line.slice(sep + 1).toLowerCase() === 'true',
        })
      }
    )
  })
}

// ─── macOS / Linux ────────────────────────────────────────

// macOS 用 AppleScript 查最前应用名（无全屏判断）；Linux 桌面差异大，暂不检测。
async function getFrontWindowInfo(): Promise<FrontWindowInfo | null> {
  if (process.platform === 'win32') return getFrontWindow()
  if (process.platform === 'darwin') {
    const name = await new Promise<string | null>((resolve) => {
      execFile(
        'osascript',
        [
          '-e',
          'tell application "System Events" to get name of first application process whose frontmost is true',
        ],
        { shell: false },
        (_err, stdout) => resolve(stdout.trim() || null)
      )
    })
    return name ? { processName: name, fullscreen: false } : null
  }
  return null
}

// ─── 轮询 ────────────────────────────────────────────────

const POLL_MS = 2000

export class GameWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private active = false

  constructor(private scheduler: JobScheduler) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.active) {
      this.active = false
      this.scheduler.setGameActive(false)
    }
  }

  private async tick(): Promise<void> {
    const info = await getFrontWindowInfo()
    if (!info) return
    // 全屏优先：任何前台窗口全屏都视为游戏（浏览器/视频播放器全屏也会命中，
    // 这是全屏优先的预期代价）；不全屏时才查进程名名单。
    const game = info.fullscreen || GAME_PROCESSES.has(info.processName.toLowerCase())
    if (game === this.active) return
    this.active = game
    this.scheduler.setGameActive(game)
    logInfo(
      game
        ? `检测到游戏 ${info.processName}${info.fullscreen ? '（全屏）' : ''}，暂停后台压缩任务`
        : '游戏已退出，恢复后台压缩任务'
    )
  }
}
