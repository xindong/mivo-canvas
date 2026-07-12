import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// G2.1 临时测试配置(不入库):主仓 vitest.config.ts 排除 **/_tmp/** 防止 worktree
// 污染跑分,但本 worktree 恰在 _tmp 下 → 需本配置取消该 exclude 才能 run。
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['server/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.bench.test.ts'],
  },
})
