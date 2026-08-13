import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // 与 electron.vite.config.ts 保持一致，让 main 层的调度器也能被单测 import
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    // 纯函数与调度器状态机；需要 Electron 运行时/真实子进程的部分不在这里测
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
