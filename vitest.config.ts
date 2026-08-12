import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只跑 shared 层的纯函数测试；main/renderer 需要 Electron 运行时，不在单测范围
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
