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

## 部署

当用户说"部署"/"deploy"（不需要更多修饰）时，直接执行，不要只给建议或分步骤讲解：

```bash
MIVO_DEPLOY_HOST=<部署机地址> MIVO_DEPLOY_USER=<部署机账号> scripts/merge-and-deploy.sh <PR_NUMBER>
```

执行前按顺序确认这些信息，缺了就问用户，不要瞎猜/编造：

- **PR_NUMBER**：用户话里带了 PR 号就直接用；没带就用 `gh pr view --json number` 或 `gh pr list --state open --head <当前分支>` 找当前分支对应的 PR；找不到再问用户要
- **MIVO_DEPLOY_HOST / MIVO_DEPLOY_USER**：部署机地址和账号。这两个故意不给默认值——仓库是公开的，不能把生产机地址写进代码库。检查本机环境变量有没有设，没设就问用户要，不要编造或复用旧的记录

这一条命令会自动做完：合并 PR（要求已 approve + CI 绿，否则 `gh pr merge` 直接失败，不会绕过审核）→ SSH 上部署机跑 `deploy.sh`（git pull + npm ci + build + pm2 restart + healthz 检查）。跑完把脚本的输出原样贴给用户，尤其是最后 `[deploy] OK` 还是 `[deploy] FAILED`。
