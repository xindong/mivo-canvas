import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// vitest 配置（test:unit / preflight / required gate）：排除 worktree / dist /
// node_modules 下的 test 文件，避免扫到 _tmp/worktrees 残留（本地 worktree 工作产物，
// 非仓库 tracked）；CI checkout 干净时无影响。
// 微基准（*.bench.test.ts）已拆出本配置，由 vitest.bench.config.ts + npm run test:bench
// 单独运行，不再进 test:unit / required gate——毫秒级阈值在共享 runner 上 flake 会
// 挡住与被测 PR 无关的合并队列，沿革见 issue #172。
export default defineConfig({
  plugins: [react()],
  test: {
    exclude: ['**/node_modules/**', '**/_tmp/**', '**/dist/**', '**/*.bench.test.ts'],
  },
})
