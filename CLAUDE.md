# MivoCanvas

> 创建日期：2026-07-01
> 技术栈：node（TypeScript + Vite + React + LeaferJS + Zustand）
> 来源：完整克隆自 github.com/xindong/mivo-canvas（2026-07-04 迁移到组织仓，保留全部 commit 历史，origin 指向组织仓）

## 项目目标

桌面式 AI 艺术画布交互 Demo（Vite+React+TS+LeaferJS+Zustand），无限画布+FigJam 风格标注+AI 图像生成工作流。

## 技术栈

- **主语言**：TypeScript（node）
- **框架/库**：
  - React 19 + react-dom
  - LeaferJS 2.1（leafer-ui + @leafer-in/editor + @leafer-in/view）— 画布渲染引擎
  - Zustand 5 — 本地状态持久化
  - react-markdown + remark-gfm — Markdown 节点渲染
  - lucide-react — 图标
- **运行环境**：Vite 8（dev/build）、Node.js、浏览器
- **测试**：Playwright（e2e smoke）

## 目录约定

```
Project MivoCanvas/
├── CLAUDE.md           # 本文件 — 项目指引
├── VERSIONING.md       # 版本管理规范
├── README.md           # 源仓产品说明（产品方向笔记，勿覆盖）
├── .gitignore          # Git 忽略规则（Vite 默认 + ECC 规则合并）
├── src/                # 源代码
├── docs/               # 文档（含 figjam-quickbar-study 等）
├── public/             # 静态资源
├── scripts/            # 脚本（e2e-smoke.mjs 等）
├── config/             # 配置（不含 .env）— 按需新建
├── data/               # 数据文件（大数据用 Git LFS 或外置存储）— 按需新建
└── history/            # ECC 会话数据（不入 git）
    ├── checkpoints/
    └── daily/
```

> 注：src/docs/public/scripts 为源仓既有结构，按源仓约定维护。新增文件遵循 `~/.claude/rules-lib/project-structure.md` 分类。

## 协作约定

- **AI 助手**：Claude Code（主），其他 provider 通过 `/ask` 调用
- **代码评审**：通过 `/review` 触发
- **测试覆盖**：参见 VERSIONING.md

## 代码规范

- 遵循 `~/.claude/rules/node/` 下的语言规范（项目为 node/TS）
- 全局规范：`~/.claude/rules/common/`
- 项目特定 invariants：
  - **开发反馈/日志**：所有用户可见功能必须遵循 `docs/development-logging.md`。会改变状态、加载数据、执行工作流、跳过不可用路径或失败的操作，都必须通过 `debugLogger` 写入 Debug Log；需要即时用户反馈的操作同步使用 `toastFeedback`。新增按钮、菜单项、画布动作、资源流程、导入导出、设置项和 AI 工作流时，默认把成功、跳过、失败路径的日志一起补齐，不等到 review 再提醒。

## 敏感数据保护

**绝不入 git 的内容**：
- `.env`、`*.key`、`*.pem`、`credentials/`、`*.token.json`、`.auth.json`
- 任何含 API key / OAuth token / 密码的文件
- 用户个人信息（PII）

`.gitignore` 已配置基础排除（含 ECC 规则）。新增敏感文件类型时同步更新。

## 测试与守卫

- **开发**：双进程拓扑，先启动 `npm run start:server`（BFF），再启动 `npm run dev`（Vite dev server）
- **构建**：`npm run build`（`tsc -b && vite build`，含类型检查）
- **Lint**：`npm run lint`（eslint .）
- **预览**：`npm run preview`
- **日志规则守卫**：`npm run verify:logging`
- **E2E**：`npm run test:e2e`（dev 双进程拓扑，Playwright）
- **本地资源目录**：默认读 `~/Desktop/Images`，可用 `MIVO_ASSET_DIR=/path npm run dev` 覆盖
- **Eagle 接入**：默认 `http://127.0.0.1:41595`，可用 `MIVO_EAGLE_API_URL` 覆盖

## 版本管理

详见 `VERSIONING.md`。

**核心约定**：
- 提交触发：手动喊"提交代码"/"commit" → `commit-projects` skill
- 分支策略：`main` 为主分支
- Push 策略：`main` 有分支保护（PR + 6 项 CI 必绿 + 管理员不豁免）；一律从分支提 PR，禁止直接 push `main`。

---

## 项目特定记录

- **来源**：2026-07-01 完整克隆自原始仓；2026-07-04 迁移到组织仓 github.com/xindong/mivo-canvas（保留 main 分支与 commit 历史）。
- **脚手架**：CLAUDE.md / VERSIONING.md / .gitignore（ECC 合并）/ history/ / pre-commit hook 由 `new-project` skill 于克隆后叠加，作为独立 commit 入库。

（在此追加项目的具体决策、踩坑、TODO）
