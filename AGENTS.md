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

用户说"部署"/"部署到服务器"/"deploy"（没提 PR 号）时，视为"main 已经 merge 好了，直接把最新代码部署上去"，直接执行，不要多问、不要只给建议：

```bash
MIVO_DEPLOY_HOST=10.102.80.15 MIVO_DEPLOY_USER=yanjian scripts/merge-and-deploy.sh
```

如果用户话里明确带了 PR 号（比如"合并 137 然后部署"），才把 PR 号带上：

```bash
MIVO_DEPLOY_HOST=10.102.80.15 MIVO_DEPLOY_USER=yanjian scripts/merge-and-deploy.sh <PR_NUMBER>
```

这条命令会：（带 PR 号时）先合并 PR（要求已 approve + CI 绿，否则 `gh pr merge` 直接失败，不会绕过审核）→ SSH 上 `10.102.80.15` 跑 `deploy.sh`（git pull + npm ci + build + pm2 restart + healthz 检查）。跑完把脚本输出原样贴给用户，尤其是最后一行 `[deploy] OK` 还是 `[deploy] FAILED`。

`10.102.80.15` 是内网地址，只在这个说明文件里出现，不要额外写进 `scripts/` 下的脚本本体——脚本本身的 `MIVO_DEPLOY_HOST`/`MIVO_DEPLOY_USER` 必须保持无默认值（仓库公开，不能把部署机信息硬编码进代码）。
