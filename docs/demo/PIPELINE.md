# MivoCanvas Demo 交付流水线（overnight loop 真相源）

> 建立：2026-07-01 晚
> 目标：明早可开浏览器验收的 AI 画布 demo。本文件是整晚 loop 的**状态源**——所有 worker 与 lead 每轮都先读它。

## 0. 目标 & 最终验收方式（独立真相源）
- **目标**：一个能在浏览器里跑通的 MivoCanvas demo。
- **最终验收（真相源，非文档自证）**：`npm run dev` 起前端，浏览器里能演示：
  1. 主对话框输入 prompt → 空画板出一张图；再用「图生图」（传参考图）出图。
  2. 对已生成图，用**锚点**（点选 + 框选/涂抹）+ prompt 做**局部重绘**，结果作为派生新图落画布（原图不覆盖）。
  3. 连本地 Eagle 素材库，展示 **tag 目录**（分类）+ 该 tag 下图片的**瀑布流(masonry)**，**点 tag 目录切换分类**，卡片可**看大图 / 右键复制 / 多选批量复制→粘贴到画板**，也可拖入画布（不做搜索；卡片不显示每图 tag）。
- 交付即：上面三条在浏览器里真实可跑（不是 mock）。

## 1. 今晚范围
**做**（6 模块）：
- **M0 生成接入**：vite dev 中间件里薄代理，藏 key，转发 `llm-proxy.tapsvc.com` 的同步图像接口。
- **M1 主对话框**：文生图 + 图生图，从空画板出图。
- **M2 锚点二改**：点/框/涂抹 → 前端合成 mask → `/v1/images/edits` 局部重绘 → 派生回填。
- **M4 Eagle 瀑布流**：读取 Eagle **tag 目录** + 图片，masonry 瀑布流展示，**点 tag 目录切换分类**（卡片不显示每图 tag），卡片**点击看大图 / 右键复制 / 多选批量复制→粘贴到画板**，也支持拖入画布（**不做搜索**；多图复制走 app 内部剪贴板）。
- **M5 画布派生模型**：生成/编辑结果挂 Edge 派生链，非破坏。
- **M6 通用工具条**：居中底部 floating 工具条（参考 loveart），挂生成/局部重绘入口；内容以 `research-toolbar.md` 为准（另派 worker 调研）。
- **布局硬约束**：保留左侧 ProjectSidebar（项目分类/创建项目/对话区分画布）形态；自由画布技术方案不变；首次生图对话框放画布**右下角**。

**今晚明确不做**（用户指示 / Non-goal）：
- **M3 图片审核打分**：右键「审核」→ 打分。用户明早给 DB + 审核标准 + 审核代码/链路，今晚不碰。
- 登录流（用 key 直连，无 OAuth）。
- 前端引擎迁移（React DOM + Zustand + LeaferJS 空壳保持不变）。
- Figma 导入。

## 2. 已验证事实（构建依据，已实测/读码确认）
- **主模型 = `gpt-image-2` via `https://llm-proxy.tapsvc.com`（OpenAI 兼容，同步）**，key 已实测出图（HTTP 200，合法 PNG）。
  - 文生图：`POST /v1/images/generations`（JSON）`{model:"gpt-image-2",prompt,n,size,quality}`，`Authorization: Bearer <key>`，返回 `data[].b64_json`。
  - 图生图/局部重绘：`POST /v1/images/edits`（multipart）`image`（原图）+ `mask`（PNG，透明=要改）+ `model`+`prompt`+`size`+`quality`。同步返回 `data[].b64_json`。
  - 范本代码：`reference/projects/XD-AIGC-toolbox/tools/tap-avatar-frame/server.js`（注意：该文件只传 image，不传 mask；mask 拼法需按 OpenAI images/edits 标准补）。
- **key**：`secrets/image-key.raw`（gitignored，600），后续以 env 方式读，禁止入 git / 禁止进前端 bundle（只在 Node 侧中间件用）。
- **gemini-3-pro-image = 可选**：toolbox 里它走 mivoserver（aigc.xindong.com，异步+另一套 token），不在 llm-proxy。构建时试 `model:gemini-3-pro-image` 打 llm-proxy；不通则仅保留 gpt-image-2，M2 mask 一律 gpt-image-2。
- **UI 样式参照现有 MivoCanvas**，交互框架不变。
- 前端现状基线见 `../baseline-inventory.md`；全栈盘点见 `../mivo-system-inventory.md`；架构见 `../architecture.md`。

## 3. Loop 7 要素
- **目标**：见 §0。
- **状态来源**：本文件 §5 阶段表 + `docs/demo/` 下各产出物 + git 分支 `demo/canvas-ai`。
- **单轮动作**：推进 §5 里当前未完成阶段的**一个**阶段。
- **验证方式**：P1/P2 产出物完整性；P3/P5 = claude + `gpt-5.5`(标准 tier, xhigh) 双审 APPROVED；最终 = 浏览器实跑三条链路。
- **停止条件**：五模块在浏览器跑通且代码双审 APPROVED；或触达升级条件。
- **预算限制**：整晚；双审每阶段最多 2 轮修复；worker 出错重试上限 1。
- **人工升级条件**：见 §6。

## 4. 执行约束
- 分支：`demo/canvas-ai`（本地；origin 指 upstream 不可 push）。
- **所有 worker 模型**：统一官方标准 `gpt-5.5`（tier=standard，**非骨折** `codex/gpt-5.5`）+ effort=`xhigh`。研究 / 计划审核 / 代码审核 / 执行一律如此。
- **执行以串行为主**：M0-M5 会改重叠文件（canvasStore/App/canvas 组件/vite.config），真并行多 worker 写同仓 = 冲突。仅在 gd-plan 明确判定无文件重叠时才并行（用 worktree 隔离）。
- 每个功能模块完成即自验（起 dev server 或 e2e 冒烟），不攒一起交。
- 审核 worker「拒绝只读」：必须实际 build/run/给出可执行修订，不能只读点评。

## 5. 阶段 DAG & 状态
| 阶段 | 产出 | 执行 | 验证 | 状态 |
|------|------|------|------|------|
| P0 预检 | 环境/key/仓/团队确认 | lead | 全绿 | ✅ done |
| P1 研究 | `docs/demo/reuse-inventory.md`（三仓·五模块 可复用/需重写清单） | 3 worker（open-design / toolbox / mivo-server，gpt-5.5 xhigh）→ lead 合成 | 清单覆盖 5 模块、含 file:line | ✅ done（reuse-inventory.md 已合成 + 3 份 research-*.md） |
| P2 计划 | demo 总计划 + 每步详细计划 | lead 跑 /gd-plan | 计划可执行、边界清 | ✅ done（master + step-M0/M1/M2/M4/M5/M6，grep 终校✓） |
| P3 计划双审 | 双审通过的计划 | 2× `gpt-5.5`(标准) xhigh + lead 合并 | claude+gpt 双 APPROVED | ✅ done（round2 双 APPROVED + claude 复验；1 轮修复；2 P3 已消化） |
| P4 执行 | demo 代码 | goal + worker（gpt-5.5 xhigh，按 DAG 串行为主） | 每模块自验 | ⏳ 进行中 |
| P5 代码双审 | 双审通过的代码+执行结果 | 2× `gpt-5.5`(标准) xhigh（实跑） | claude+gpt 双 APPROVED + dev 跑通 | ⬜ |
| P6 验收 | — | 用户明早浏览器 | 三条链路可演示 | ⬜ |

## 6. 人工升级条件（触达则停下留言，不硬撑）
- llm-proxy key 失效 / gpt-image-2 不可用（已实测 OK，运行中若变则停）。
- 某阶段双审 2 轮仍不过。
- 执行撞到需用户决策的岔口（如 gemini 路线、Eagle 未运行、mask 语义与预期不符）。
- 需要 M3 材料才能继续的任何点（今晚不等，标注留明早）。
