import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// vitest 配置（test:unit / preflight / required gate）：排除 worktree / dist /
// node_modules 下的 test 文件，避免扫到 _tmp/worktrees 或 .claude/worktrees 残留（本地多 worker
// worktree 工作产物，非仓库 tracked，会被并发 worker 的 worktree 测试污染本 PR 的跑分）；
// CI checkout 干净时无影响。
// 微基准（*.bench.test.ts）已拆出本配置，由 vitest.bench.config.ts + npm run test:bench
// 单独运行，不再进 test:unit / required gate——毫秒级阈值在共享 runner 上 flake 会
// 挡住与被测 PR 无关的合并队列，沿革见 issue #172。
export default defineConfig({
  plugins: [react()],
  test: {
    exclude: ['**/node_modules/**', '**/_tmp/**', '**/.claude/worktrees/**', '**/dist/**', '**/*.bench.test.ts'],
  },
})
