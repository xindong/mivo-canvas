import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// vitest 配置：排除 worktree / dist / node_modules 下的 test 文件，避免扫到 _tmp/worktrees
// 残留（本地 worktree 工作产物，非仓库 tracked）。CI checkout 干净时无影响。
export default defineConfig({
  plugins: [react()],
  test: {
    exclude: ['**/node_modules/**', '**/_tmp/**', '**/dist/**'],
  },
})
