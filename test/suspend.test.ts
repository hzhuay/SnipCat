import { describe, it, expect } from 'vitest'
import { suspendPid, resumePid, isSuspendSupported } from '../src/main/ffmpeg/suspend'

const isWindows = process.platform === 'win32'

describe('suspend/resume (POSIX)', () => {
  it.skipIf(isWindows)('对不存在的 pid 调用 suspendPid 不抛异常，正常 resolve', async () => {
    await expect(suspendPid(999999)).resolves.toBeUndefined()
  })

  it.skipIf(isWindows)('对不存在的 pid 调用 resumePid 不抛异常，正常 resolve', async () => {
    await expect(resumePid(999999)).resolves.toBeUndefined()
  })

  it.skipIf(isWindows)('对真实子进程 SIGSTOP 后进程仍存活（只是被冻结），SIGCONT 后可正常终止', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn('node', ['-e', 'setInterval(() => {}, 50)'])
    await new Promise((r) => setTimeout(r, 50))

    await suspendPid(child.pid!)
    // 挂起状态下进程仍存在（kill -0 不抛异常）
    expect(() => process.kill(child.pid!, 0)).not.toThrow()

    await resumePid(child.pid!)
    child.kill('SIGKILL')
  })

  it('isSuspendSupported 在当前平台返回 true', () => {
    expect(isSuspendSupported()).toBe(true)
  })
})
