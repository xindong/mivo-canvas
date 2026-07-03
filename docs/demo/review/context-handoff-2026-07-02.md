# MivoCanvas Context Handoff - 2026-07-02

## Authority Roots

- Project root: `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`
- Runtime (dev server, may still be running): `http://127.0.0.1:5175/` — Vite dev server, node PID 57100（本会话后台任务 `b07r3jx1b`；新窗口无此任务句柄，视为孤儿进程，需要停用 `lsof -nP -iTCP:5175 -sTCP:LISTEN` 找 PID 后 kill）
- Control-plane workspace: 无（纯项目内工作）
- Git remote `origin`: `https://github.com/kirozeng/MivoCanvas.git` — **私有仓，owner=kirozeng（非你），PraiseZhu 有 push 权限（viewer_push=true）**

## Hard Boundaries

- **不合到 main（本地 + 远端都不动）**。整个 demo（M0–M6）只活在 `demo/canvas-ai`，未并回 main。
- **PR #8 保持 draft**（草稿机制上无法被误合），评审通过要合时才 `gh pr ready 8`。
- **别动已验证 OK 的 mask 前端交互**，除非是有意识重构并先固化基线：`src/canvas/ImageMaskEditOverlay.tsx`、`src/canvas/imageMaskGeometry.ts`、`src/canvas/useCanvasInteractionController.ts`（点选/框选/涂抹 + regionCount/draftRef 逻辑已 mock 走查验证正确，P1 的 bug 不在这，历史上反复返工过）。
- **`_tmp/` 不入 git**：`.gitignore` 目前**未覆盖** `_tmp`，禁止 `git add .` 误提交调试截图。
- **局部重绘的深做在独立分支上进行**，base 选 `demo/canvas-ai`（不是 main）；否则拿不到 M2/M5 与 P1/P2/P3 修复。
- CLAUDE.md 里仍有一条**过时约定**"origin 指向 upstream 不可直接 push"——实际是私有仓 + 你有写权限、且本会话已成功 push。改这条治理文档前需用户显式授权（本会话已提议，用户尚未确认）。

## Current State

已定事实（settled）：

- 当前分支 `demo/canvas-ai`，HEAD = `8fa20b9`，本地与 `origin/demo/canvas-ai` **一致（已推送）**。
- **M0–M6 全部已提交**在 `demo/canvas-ai`：`4e174c2`(M0) `a687e4f`(M1) `e3c479e`(M2) `72c8047`(M4) `0e5e597`(M5) `9a75216`(M6) + 4 个旧修复(`c4d9ac5`/`5e6b8bf`/`6160c38`/`b97249b`)。提交历史无独立 M3 commit（疑编号合并，未确认）。
- **本轮验证 + 修复已完成并提交（`8fa20b9`）**：两个 Orca worker 真实环境走查 → 合并出 P1/P2/P3 → 已修复自验（`npm run build` + `npm run test:e2e` 均通过）。
- **PR #8 = OPEN / draft / base=main / head=demo/canvas-ai**：`https://github.com/kirozeng/MivoCanvas/pull/8`，未合并。
- 工作区未提交项（均**不影响功能完整性**，不在分支 commit 内）：`docs/demo/PIPELINE.md`(会话前已改) + 未跟踪的 `_tmp/`(调试截图) + `docs/demo/review/*.md`(验证报告)。
- Orca：3 个 worker 全 `done`（`research-mivoserver` 广度走查、`research-toolbox` 核心验证+修复、`research-open-design` 未派活）。

上游 vs 本轮：M0–M6 是上游已交付；P1/P2/P3 是本会话新修。

## Key Artifacts

- `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/docs/demo/review/full-chain-ui-walkthrough.md` — 广度 M1–M6 走查报告（APPROVED，含 22 张截图）
- `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/docs/demo/review/code-review-run.md` / `code-review-quality.md` / `ui-audit.md` — 各轮 review 产物
- `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/_tmp/core-demo-validation-2026-07-02_03-23-00/` — 核心 4 功能验证证据（含 P1 超时截图 `08-f2-mask-timeout.png`、`result.json`）
- `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/_tmp/fix-validation-2026-07-02T04-34-37/` + `_tmp/fix-validation-p2-2026-07-02T04-39-01/` — 修复轮验证证据
- `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/_tmp/edit-repro-2026-07-02T04-17-40-same-size/` + `_tmp/edit-repro-2026-07-02T04-21-37-generated-source/` — P1 根因请求耗时证据（edit 上游 54.6s/98s/69.1s）

局部重绘链路文件分层（协作分工用）：

- edit API 路径（P1 修复所在，真正该细做处）：`src/lib/mivoImageClient.ts`(editMivoImage timeout 185s)、`vite.config.ts`(proxyMivoEdit timeout 180s)
- 前端 mask 交互（勿轻动）：`src/canvas/ImageMaskEditOverlay.tsx`、`src/canvas/imageMaskGeometry.ts`、`src/canvas/useCanvasInteractionController.ts`
- 触发入口 + 衍生落点（高危共享文件）：`src/store/canvasStore.ts`、`src/canvas/MivoCanvas.tsx`、`src/App.tsx`、`src/canvas/actions/*`、`NodeActionMenu.tsx`、`SelectionQuickToolbar.tsx`、`CanvasAiActionBar.tsx`

## Open Findings / Risks

- **[P1 本质未解，仅缓解] 局部重绘 `/api/mivo/edit` 上游本身慢（实测 54.6s–98s）**。本轮只把超时窗口从 ~110s 放宽到 180s(代理)/185s(客户端)，让慢调用能等到结果——**不是提速**。用户盯 ~1min 无明确进度，体验差；极端情况仍可能超 180s。深做应聚焦：真实进度反馈/可取消、edit 能否更快（尺寸/参数/上游）、超时重试。**别只调超时数字**。证据见上方 `edit-repro-*`。
- **[协作分叉风险 P2] 共享文件冲突**：`canvasStore.ts` / `MivoCanvas.tsx` / `App.tsx` 既是 demo 主干常改、又是局部重绘要碰的。两人并行改同一批文件，git 机制解决不了同行冲突——必须靠**文件边界约定 + 同事分支勤同步 `demo/canvas-ai`（≥每天 merge）+ 短命小步合回**。
- **[卫生 P3] `_tmp/` 未 gitignore**：随时可能被误提交。建议加 `.gitignore`。

## Current Decision State

```text
full_chain_validation: FIXED_AND_VERIFIED   # P1/P2/P3 已修+自验, commit 8fa20b9
pr_8: OPEN_DRAFT_NOT_MERGED (base=main, head=demo/canvas-ai)
p1_edit_timeout: MITIGATED_NOT_FIXED         # 放宽超时窗口, 上游仍慢 ~1min
mask_edit_deep_work: PENDING                 # 待在独立分支 base=demo/canvas-ai 开工
simplify_pass: NOT_RUN                        # 5 个修复文件未跑 /simplify
claude_md_stale_push_rule: PENDING_USER_OK    # 过时"不可push"约定待授权修正
```

## Next Best Action

- 单一动作：为局部重绘深做建分支 —— `git fetch origin && git checkout -b demo/mask-edit origin/demo/canvas-ai && git push -u origin demo/mask-edit`，开一个 base 指向 `demo/canvas-ai` 的草稿 PR。
- 先读：本文件 + `docs/demo/review/full-chain-ui-walkthrough.md` + `_tmp/edit-repro-*/*.json`（理解 P1 上游耗时）。
- 不要做：不合 main、不改已验证的 mask 前端交互、不 `git add .`（会带进 `_tmp/`）、不把 PR #8 转正式合并。

## New Window Prompt

```text
继续 MivoCanvas demo 协作。

权威项目根目录：
/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas

先读取交接文件：
/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/docs/demo/review/context-handoff-2026-07-02.md

硬边界：
- 不合到 main（本地+远端），PR #8 保持 draft
- 局部重绘深做在独立分支、base=demo/canvas-ai；别动已验证 OK 的 mask 前端交互
- _tmp/ 不入 git（.gitignore 未覆盖），别 git add .
- origin=kirozeng 私有仓、你有 push 权限；CLAUDE.md "不可push" 那条已过时，改它需先授权

当前目标：
把局部重绘功能链路单独拆到新分支细做；核心是解决 edit 上游 ~1min 慢的体验（进度反馈/加速/重试），不是继续调超时数字。

下一步：
从 origin/demo/canvas-ai 切 demo/mask-edit 分支并推远端、开 base=demo/canvas-ai 的草稿 PR；同时把 _tmp/ 加进 .gitignore。
```
