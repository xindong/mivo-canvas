# M7 对话式 AI 面板（Chat Panel）— 总计划

> 建立：2026-07-02 | 分支：`demo/improve-hud`（base=`demo/canvas-ai`，已推远端）
> 目标形态参照：线上 Mivo（aigc.xindong.com/canvas）右侧对话窗口
> 现状依据：`docs/demo/CODE-INVENTORY.md` + `docs/demo/inventory/AGENT-PROMPT-ENHANCE-INVENTORY.md`（§6 自补方案是本计划的直接前提）

---

## 0. 目标与验收（真相源）

**目标**：把右侧 `AIToolPanel`（生成参数表单）替换为**带记忆的对话窗口**。用户输入一句短提示词 → 背后 agent（一次结构化 LLM 调用）做场景识别 + 参数决策 + 扩写英文 rich prompt → 生图 → **结果同时出现在对话流和画布**。同时**兼容现有锚点（mask）局部重绘**功能。

**浏览器实跑验收（非文档自证）**：
1. 对话框输入「生成一张踢球的图」→ 面板依次出现：深度思考（reasoning）→ 参数卡（场景/比例/质量/扩写后英文 prompt）→ 结果图消息；**同一张图**同时落画布为 image node（带 M5 衍生 edge 语义）。
2. 第二句「再来一张夜晚的」→ agent 拿到上一轮上下文，生成结果与第一轮主题连贯（多轮记忆生效）。
3. 刷新页面 → 对话历史仍在（持久化记忆生效）。
4. 选中画布图片 → 走局部重绘（点/框/涂抹 + prompt）→ 流程与现在完全一致跑通；重绘结果作为一条消息**回流进对话历史**。
5. 旧 `AIToolPanel` 表单与底部 `CanvasAiActionBar` 不再出现；生成入口 = 对话面板；局部重绘入口 = 节点菜单/选择工具条（+ 对话面板选中图片时的快捷按钮）。
6. `npm run build` + `npm run lint` + `npm run test:e2e` 全绿（e2e 需新增 `/api/mivo/enhance` mock）。

---

## 1. 已拍板的设计决策（lead 决定，worker 不再讨论）

| # | 决策 | 理由 |
|---|------|------|
| D1 | **不接 mivo-server runtime**，agent = vite 中间层一次结构化 LLM 调用（`POST /api/mivo/enhance`） | 两轮独立盘点同一净建议；FastAPI/TaskIQ/Mongo 对 demo 过度设计 |
| D2 | "深度思考"先做**非流式**（方案 A）：请求期间转圈，返回后一次性揭示 reasoning+参数卡 | 最快闭环；SSE 流式（方案 B）列为后续增强，不阻塞 |
| D3 | **移除 `AIToolPanel` + `CanvasAiActionBar` 两者** | 用户指令"去掉右侧底部的工具条"；对话面板接管生成入口；mask 入口保留在 `NodeActionMenu`/`SelectionQuickToolbar`（两处现成，不受影响） |
| D4 | 对话记忆 = **双层**：① UI 消息流持久化（zustand persist，按 sceneId 隔离）② enhance 请求带最近 N 轮（N=6）对话摘要作多轮上下文 | "带记忆"两个含义都要：刷新不丢 + 上下文连贯 |
| D5 | mask 前端交互三件套（`ImageMaskEditOverlay`/`imageMaskGeometry`/`useCanvasInteractionController`）**零改动** | 交接文件硬边界，历史上反复返工 |
| D6 | mask 重绘结果回流对话：在 `commitGenerationResult` 落点统一追加 chat 消息（所有生成源共用），**不改 submitMaskEdit 链路** | 单点接入、天然覆盖对话/mask/未来其他生成源 |
| D7 | 手动比例/质量选择器 v1 **不保留**（agent 决策 + 参数卡展示）；参数卡上提供「用原文直接生成」逃生口 | 对齐目标产品形态；兜底可控 |
| D8 | 画布落点沿用现有 store 动作：无选中 → 建 ai-slot + `generateIntoAiSlot`；选中 image → `generateBesideNode`（衍生 edge 走 M5 现成逻辑） | 不新增落点体系，`commitGenerationResult` 契约不动 |
| D9 | chat 状态放**独立 store 文件** `src/store/chatStore.ts`（不塞进 canvasStore） | canvasStore 是高危共享文件，最小化触碰面 |
| D10 | enhance 失败 → 原文 + 默认参数直接生成，消息里显式标注「未增强」；JSON 不合法 → clamp 回默认 | 显式失败不静默（清单 §6.6） |

**待用户确认的岔口（P0 探针结果出来前不阻塞开工）**：
- ⚠️ `llm-proxy.tapsvc.com/v1/chat/completions` 是否可用同一 key —— P0 先探；不通则需要用户给 chat LLM 端点/key。

---

## 2. 架构

```
ChatComposer 输入短 prompt（可附参考图 / 隐式带选中节点）
  → chatStore.sendMessage()
    ① 追加 user 消息 + "深度思考中" 占位
    ② POST /api/mivo/enhance   { userPrompt, history(≤6轮摘要), hasReference, selectedImageMeta }
       ← { mode, sceneType, enhancedPrompt(EN), aspectRatio, quality, reasoning }
    ③ 替换占位为 reasoning 消息 + 参数卡消息
    ④ 按 mode 调现有 store 动作（generateIntoAiSlot / generateBesideNode）
       → 现有 /api/mivo/generate|edit → commitGenerationResult → 画布 node+edge
    ⑤ commitGenerationResult 钩子 → 追加 image 结果消息（含 nodeId，可点击定位画布）
```

- **`/api/mivo/enhance`**（vite.config.ts 新路由，与 generate/edit 并列）：服务端读 `MIVO_LLM_API_KEY`（缺省回退 `MIVO_IMAGE_API_KEY`），调 chat completions，强制 JSON 输出 + 服务端 schema 校验 + clamp。
- **System prompt**（自写，线上那份不存在于任何仓）：场景识别 → 比例/质量决策表；中文短输入 → 忠实、具体的英文 prompt；禁堆 `4K/masterpiece/cinematic`（借 toolbox `shared/llm.py:15` 约束）；不擅自加人物/场景/道具（借 ro-story `server.js:594-605` 锁定约束）；只输出 JSON。
- **参数映射**：aspectRatio+quality → size，抄 mivo-server `openai.py:19-63`（与现有 `/api/mivo/*` size 契约一致）。

## 3. 数据模型

```ts
// src/store/chatStore.ts（zustand + persist，key: mivo-chat-v1，按 sceneId 分桶）
type ChatMessage = {
  id: string
  sceneId: string
  role: 'user' | 'assistant'
  kind: 'text' | 'reasoning' | 'params' | 'image-result' | 'error' | 'notice'
  text?: string                       // text/reasoning/error/notice
  params?: EnhanceResult              // 参数卡
  nodeId?: string                     // image-result → 画布节点（点击定位）
  assetRef?: string                   // 结果图缩略（复用现有 asset 解析）
  origin?: 'chat' | 'mask-edit'       // 结果来源标注
  status: 'pending' | 'done' | 'failed'
  createdAt: number
}
```

- 持久化只存消息元数据 + assetRef（图走现有 IndexedDB 体系，不进 localStorage）。
- enhance 的多轮上下文 = 该 scene 最近 6 轮 user/assistant 文本摘要（不带图）。

## 4. 组件拆分（全新文件，替换 AIToolPanel）

```
src/app/chat/
├── ChatPanel.tsx        # 容器：header + MessageList + Composer；open/collapse 沿用 App.tsx 现有 aiPanelOpen 编排
├── ChatMessageList.tsx  # 消息流（自动滚底、按 kind 分发气泡）
├── ChatMessageItem.tsx  # 气泡变体：user / reasoning(可折叠"深度思考") / 参数卡 / 结果图卡 / error(带重试) / notice
├── ChatComposer.tsx     # 输入区：textarea + 参考图 chips(拖/贴/点，逻辑迁自 AIToolPanel) + 发送；选中 image 节点时显示「局部重绘」快捷按钮(触发现有 mask 入口)
└── chatPanelTypes.ts
```

- CSS 追加进 `App.css`（沿用 `--charcoal/--moss/--line` token 与现有 ai-panel 视觉语系，浅色主题不照抄线上深色）。
- 收起态保留窄条 rail（沿用现 `ai-panel collapsed` 模式）。

## 5. 改动面清单（风险分级）

| 文件 | 动作 | 风险 |
|------|------|------|
| `src/app/chat/*`、`src/store/chatStore.ts`、`src/types/chat.ts` | 新增 | 低（新文件） |
| `vite.config.ts` | 新增 enhance 路由 + system prompt 常量 | 中（共享文件，纯增量） |
| `src/App.tsx` | AIToolPanel → ChatPanel；删 CanvasAiActionBar 相关 props 透传；保留 mask 时收起面板逻辑(P3) | 中 |
| `src/canvas/MivoCanvas.tsx` | 移除 CanvasAiActionBar 渲染与 props | 中（只删不改其他） |
| `src/store/canvasStore.ts` | `commitGenerationResult` 尾部加一个可选通知钩子（chatStore 订阅） | **高危共享文件，改动 ≤10 行** |
| `src/app/AIToolPanel.tsx`、`src/canvas/CanvasAiActionBar.tsx` | 删除（连同 CSS 与引用） | 低 |
| `scripts/e2e-smoke.mjs` | 增 enhance mock + 对话链路冒烟；删对 action bar 的断言 | 中 |
| **禁改** | mask 三件套、`imageMaskGeometry`、mivoImageClient 契约、`/api/mivo/generate|edit` 契约 | — |

保留不动：`TaskQueue`（生成任务队列照常工作）、`NodeActionMenu`/`SelectionQuickToolbar` 的 mask 入口。

## 6. 执行阶段（worker 编排，串行为主）

| 阶段 | 内容 | 产出 | 依赖 |
|------|------|------|------|
| **W0 探针**（先行，≤30min） | 用 `MIVO_IMAGE_API_KEY` 实测 llm-proxy `/v1/chat/completions`（含 JSON mode） | 通/不通结论 + 可用模型名 | — |
| **W1 后端** | enhance 路由 + system prompt 全文 + schema 校验/clamp + 失败兜底；curl 自验 | vite.config.ts 增量 commit | W0 通 |
| **W2 状态层** | chatStore + 消息模型 + persist + commitGenerationResult 钩子（canvasStore ≤10 行） | commit + 单元级自验 | 可与 W1 并行（新文件为主） |
| **W3 UI** | chat/ 四组件 + CSS + 收起态 | commit，mock enhance 下可视自验 | W2 |
| **W4 集成收口** | App/MivoCanvas 接线、删旧面板与工具条、mask 回流消息、e2e 更新、真跑三验收链路 | commit + 截图证据 | W1+W3 |
| **W5 双审** | 按流水线惯例双审（实跑，非只读点评） | APPROVED | W4 |

- 所有 worker 改动落 `demo/improve-hud`；W2/W3 若并行用 worktree 隔离，其余串行。
- 每阶段完成即 commit（检查点原则），最后开 base=`demo/canvas-ai` 的 draft PR。

## 7. 兜底与显式失败

1. enhance HTTP 失败/超时(30s) → 原文+默认参数（1:1/medium）直接生成，消息标注「未增强，已按原文生成」。
2. enhance 返回非法 JSON/越界参数 → 服务端 clamp 回默认并在响应标 `degraded: true`，前端参数卡显示降级标记。
3. 生成阶段失败 → error 消息 + 重试按钮（重试仅重放生成，不重跑 enhance）。
4. chat 持久化损坏 → 清空该 scene 消息重建，不影响画布数据（两 store 隔离）。

## 8. 明确不做（v1）

- SSE 流式 reasoning（方案 B，后续增强）
- 模型选择 UI / 多模型路由（enhance 服务端定死一个中档 chat 模型）
- 手动比例/质量选择器（agent 决策）
- variation/annotation mock 链路改造（维持现状）
- 生产化后端抽离（demo 仍活在 vite middleware）
