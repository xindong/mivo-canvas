import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// vitest 微基准配置（test:bench / CI bench job）——与主配置 vitest.config.ts 拆分：
// 只 include '*.bench.test.ts'，不进 test:unit / preflight / required gate。
// 毫秒级性能阈值在 CI 共享 runner 与本地负载波动下反复 flake，会挡住与被测 PR 无关的
// 合并队列；性能回归监控与功能正确性闸门不应同一条生死线（issue #172 方向 1）。
// CI bench step 设 continue-on-error=true，非阻断，只报告不阻断合并。
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.bench.test.ts'],
    exclude: ['**/node_modules/**', '**/_tmp/**', '**/dist/**'],
  },
})
