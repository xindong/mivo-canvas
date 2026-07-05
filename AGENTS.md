# AGENTS.md

MivoCanvas — 桌面式 AI 艺术画布交互 Demo（Vite + React + TS + LeaferJS + Zustand）。

## 开工第一件事

新会话/新 worker 启动后，先获取仓库地图（模块/依赖/行数/职责）：

```bash
npm run codemap
```

该命令由 `scripts/codemap.mjs` 生成，输出模块级仓库地图至 stdout。SessionStart hook 已在 `.claude/settings.json` 中接线，新会话启动时自动注入 compact 版本（≤3KB）。

## 导航规范

- 查引用/定义必须优先用 LSP findReferences/goToDefinition，grep 只做文本兜底。
- 文本搜索必须覆盖全仓（src/ + server/ + scripts/），禁止只搜单目录。

## 常用命令

| 用途 | 命令 |
|------|------|
| 开发（双进程） | `npm run start:server` 后 `npm run dev` |
| 构建 | `npm run build` |
| Lint | `npm run lint` |
| 单测 | `npm run test:unit`（vitest） |
| E2E | `npm run test:e2e` |
| 仓库地图 | `npm run codemap`（compact）/ `npm run codemap -- --full` |
