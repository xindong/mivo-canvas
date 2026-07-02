# 提示词增强 Agent — 功能代码清单（跨 mivo-server + XD-AIGC-toolbox）

> 快照：2026-07-02 | 目标：为"用这套 agent 替换 MivoCanvas 右侧工具栏 `src/app/AIToolPanel.tsx`"提供落地依据。
> 两仓均**只读**盘点，未改动。逐文件详情见文末两份 part。

## ⚠️ 结论先行（关键、诚实）

**线上 Mivo 那套完整行为（深度思考 → 场景识别 → 自动选模型/宽高比/分辨率 → 扩写 rich 英文 prompt → 同时回对话框和画布），在两个仓里都没有可直接搬运的完整代码。**

- **mivo-server**：有**真实的 Agent 运行时基建**（reasoning 流、tool calling、Seedream/gpt-image-2 图片工具、SSE 分发、多轮记忆），但截图里的"业务魔法"（场景分类、参数决策规则、那段英文 prompt）**不在仓内代码**——它由数据库 `Agent.system_prompt/tools/default_config` + Consul `SmartPrompt` + 线上运行配置驱动。仓里连测试用的 `mivo_board_agent` 都只是"有用的助手，灵活使用工具"占位。
- **XD-AIGC-toolbox**：只有**半个** —— 真实但更轻的 prompt 增强（`ro-story-studio` 中文动作润色、`shared/llm.py`+`flux-svg` 英文翻译轻增强），**没有**场景识别 / 自动选参 / rich 英文 prompt。

**两个 worker 独立得出同一净建议**：MivoCanvas **不要接 mivo-server**（依赖 FastAPI/TaskIQ/Mongo/PG/OSS/JWT/Consul，与 demo 的 React+Vite Node 直连不兼容）；应**自建一个轻量 prompt-enhance 层**替换 `AIToolPanel`，借用两仓的**模式 + 提示词模板 + 参数映射**，而非整体搬运。

---

## 目标功能定义（截图实证行为）
用户在**一个对话框**输入短 prompt（"生成一张踢球的图"）→ "深度思考结束" → 场景识别:通用运动插画 / 模型:seedream 5.0 lite / 宽高比:16:9 / 分辨率:2K → 扩写出 `Dynamic football kicking scene, soccer player in mid-action...` → 生图 → 结果同时进对话框和画布。

## 两仓命中对比

| 能力 | mivo-server | XD-AIGC-toolbox |
|---|---|---|
| 对话/多轮 + reasoning 流 | ✅ 真实基建 | ❌ |
| tool calling / 参数由 LLM 决策 | ✅ 真实 | ❌（参数来自 UI 下拉/模板） |
| prompt 扩写 | ⚠️ 靠 DB/Consul 的 system_prompt，代码里无固定模板 | ⚠️ ro-story 中文润色 / shared 英文轻增强 |
| 场景识别 → 自动选模型/比例/分辨率 | ❌ 仓内无确定性映射（LLM+配置决策） | ❌ 无 |
| rich 英文 prompt | ❌ 无固定实现 | ❌（ro-story 出中文，flux 出短英文） |
| 图像生成工具链 | ✅ Seedream + gpt-image-2 真实 | ✅ 走 Mivo Hub `/api/v1/message` |
| 结果回画布 | ❌ 前端消费 SSE，后端无画布代码 | ❌ 各工具自有历史 UI |

---

## 一、最接近目标的两条真实链路

### A. mivo-server — 真实 Agent 运行时（基建可参考，业务 prompt 缺失）
- 入口/系统提示词下发：`api/src/ai_api/v1/routers/agent.py:181-292`、`:214-252`（拼 `agent.system_prompt`+board tools 下发 worker）
- Agent 配置契约（都在 DB）：`common/src/ai_common/entity/sqlmodels/agent.py:17-59`（system_prompt/model/tools/default_config）
- 默认 agent key `mivo_board_agent`：`api/src/ai_api/v1/service/agent.py:45-47`
- Runner/执行循环：`worker/src/ai_worker/tasks/agent/logic.py:114-173`、`agent/src/ai_agent/runner.py:519-589`
- 深度思考基建：`agent/src/ai_agent/schema.py:27-30`、`agent/src/ai_agent/clients/qwen.py:399-424`、`worker/src/ai_worker/service/agent_events.py:172-190`
- Seedream 工具（含 5.0 lite 枚举）：`agent/src/ai_agent/tools/images/seedream.py:13-24,56-102`、`common/src/ai_common/tools/ark.py:101-104,115-131,154-168`
- **gpt-image-2 参数映射（demo 最该抄）**：`agent/src/ai_agent/tools/images/openai.py:19-63`（aspect_ratio+quality→size，与本 demo `/api/mivo/*` 的 `size` 契约一致）
- SSE / content_items 分发：`api/src/ai_api/v1/service/agent.py:487-550`、`worker/src/ai_worker/service/agent_events.py:224-299,414-456`
- 旁路 prompt 润色思路（模板仍在 Consul）：`api/src/ai_api/v1/service/prompt.py:98-129`、`common/src/ai_common/tools/openai.py:54-75`

### B. toolbox — ro-story-studio 的 refine 链路（形态最像，可复制交互模式）
- 前端"描述润色"入口 + 状态：`tools/ro-story-studio/public/index.html:2837`、`:2875`（POST `/api/refine-prompt`）、`:2883`（`{original,refined}` 落回输入）
- **prompt 增强核心函数**：`tools/ro-story-studio/server.js:576`（`refinePrompt({prompt,characters,scene})`）
- **系统提示词模板**：`tools/ro-story-studio/server.js:586-615`（定位"动作+表情翻译器"，锁角色关系、禁新增外观/环境；**输出中文**，非英文 rich）
- LLM 调用点：`tools/ro-story-studio/server.js:617-629`（chat completions，默认 `gpt-5.4`，temp 0.3）
- 增强后进生图：`tools/ro-story-studio/server.js:754,850`（模板拼 fullPrompt）→ Mivo Hub `:398,424`（payload `{prompt,imgRatio,resolution,n,images?,quality?}` POST `/api/v1/message`）

### C. toolbox — shared 英文翻译+轻增强（可复用模板）
- 模板：`shared/api-server/routes/llm.py:15`（`_TRANSLATE_SYSTEM`：中文→英文并轻度增强，禁堆 cinematic 等风格词，只出一句）
- 端点：`shared/api-server/routes/llm.py:31`（`POST /llm/translate` → `{original,translated}`）
- LLM 封装：`shared/api-server/lib/nova_client.py:28`（`chat(messages, model, **kwargs)`，OpenAI 兼容）
- 消费例：`tools/flux-svg/index.html:290,308,406`（中文检测→翻译→作为最终 prompt 进 ComfyUI）

---

## 二、线上"魔法"到底在哪（缺口定位）
截图里的场景分类、"踢球→16:9→2K→Seedream 5.0 lite"、那段英文 prompt —— **均未落在两仓代码**。真实来源推断：
- mivo-server DB：`agents.system_prompt / tools / default_config`（线上手工编辑：`cli/agent.py:251-298,382-435`）
- Consul：`common/src/ai_common/utils/smart_prompt.py:8-45`（`.../options/SmartPrompt/<key>`）
- 例配默认模型还是 `doubao-seedream-4-0`（`config.example.yaml:111-116`），`5.0 lite` 也来自线上配置。

**含义**：想复刻线上行为，等于要**自己写这套 system prompt + 参数决策规则**，仓库只能给你参考骨架，给不了成品。

---

## 三、可复用清单（跨两仓）
1. **gpt-image-2 的 `aspect_ratio+quality→size` 映射**（`openai.py:19-63`）——直接对得上 demo `/api/mivo/generate|edit` 的 size 契约。
2. **tool/参数 JSON Schema 让 LLM 决策**的思路（`agent/src/ai_agent/builder/tool.py:250-385`）——用于让 LLM 输出结构化的 model/ratio/resolution。
3. **流式 content-item 分离展示**（text / reasoning / tool_call / tool_result / file_meta）（`action.py:13-20`、`agent.py:487-550`）——对话框里"深度思考结束 + 参数卡 + 结果图"的展示范式。
4. **refine 交互闭环**（增强中/查看原文/撤销、`{original,refined}` 回填再生图）（`ro-story index.html:2837,2883`）。
5. **英文翻译+轻增强 system prompt 模板**（`shared/llm.py:15`）——作为"输出英文 prompt"的起点（需加强为结构化输出）。
6. **Mivo Hub / 生成请求结构**（`ro-story server.js:398,424`）——后端生成 payload 参考。

## 四、需重写 / 自建
1. **system prompt / 场景识别 / 参数决策规则**：线上不在仓内，必须自写。建议让 LLM 输出结构化 JSON：`{ enhancedPrompt(EN), model, aspectRatio, resolution, sceneType, reasoning, safetyNotes }`。
2. **React + 画布数据流**：ro-story 是原生单页 DOM；MivoCanvas 要接 `AIToolPanel` + canvas store + `commitGenerationResult` 建 node/edge + IndexedDB asset。
3. **结果双回流**：右侧对话触发后，结果**同时**进对话流和画布——需接画布 node 创建 + `sourceNodeId`/edge。
4. **安全兜底**：增强失败→保留原始 prompt 直接生成；参数决策失败→回落 demo 现有默认 model/ratio/resolution。

## 五、推荐落地路径（替换 `AIToolPanel.tsx`）
```
右侧对话框输入短 prompt
  → 本地 prompt-enhance（Vite Node route 或前端调 LLM，用自写 system prompt，输出结构化 JSON）
  → 复用 gpt-image-2 size 映射 → 现有 /api/mivo/generate|edit（无参考图走 generate，有则 edit）
  → commitGenerationResult 建 image node + 衍生 edge
  → 对话流按 content-item 展示"深度思考/参数/结果图"
```
不引入 mivo-server 任何运行时依赖；只搬模式 + 模板 + 映射。

---

## 分层详情（逐文件 part）
| Part | 覆盖 | 文件 |
|---|---|---|
| mivo-server agent 链路 | agent 运行时/图片工具/SSE/记忆 + 可复用需重写判断 | `docs/demo/inventory/agent-mivo-server.md` |
| toolbox prompt 增强链路 | ro-story-studio / shared-llm / flux-svg + 未命中工具 | `docs/demo/inventory/agent-toolbox.md` |

---

# 六、自补方案：Agent 设计与部署

> 基于对两仓源码的判断给出的落地设计。**结论：需要自补，但只补"一次结构化 LLM 增强调用"，不搬 mivo-server 的完整 agent runtime**（tool-calling 循环 + 多轮记忆 + TaskIQ 对本 demo 是过度设计）。

## 6.1 定位
一个**无状态**的"prompt 增强 + 参数决策"**单次 LLM 调用**，夹在"用户输入"和现有 `/api/mivo/generate|edit` 之间。截图里的"深度思考"是**展示层效果**，真正的决策 = 一次 LLM turn 输出结构化 JSON。

## 6.2 运行位置（沿用现有中间层模式）
- 在 `vite.config.ts` 新增中间层路由 `POST /api/mivo/enhance`，与 `generate`/`edit` 并列。
- LLM key 服务端隔离：新增 `MIVO_LLM_API_KEY`，缺省复用 `MIVO_IMAGE_API_KEY`。
- 上游：`https://llm-proxy.tapsvc.com/v1/chat/completions`（与现有图像 base `.../v1/images` 同 proxy，OpenAI 兼容）。
- **⚠️ 待确认**：该 proxy 是否开放 `/v1/chat/completions`、能否复用同一 key。此条通了整套设计成立；不通则需单独找 chat LLM 端点。

## 6.3 输入 / 输出契约（agent 的核心）
```
入: { userPrompt, hasReference: bool, selectedImageMeta?, canvasContext? }
出: {
  mode: "generate" | "edit",          // 有参考图/选中图 → edit，否则 generate
  sceneType: string,                  // 场景识别（展示 + 参数依据）
  enhancedPrompt: string,             // 扩写后的英文 rich prompt
  aspectRatio: "16:9" | "1:1" | ...,  // 映射到现有 size 契约
  quality | resolution: string,       // 复用 gpt-image-2 aspect_ratio+quality→size
  reasoning: string,                  // 供"深度思考"展示
  safetyNotes?: string
}
```
前端只信任此 JSON，再据它调现有 `/api/mivo/generate|edit`。复用映射来源：`mivo-server agent/src/ai_agent/tools/images/openai.py:19-63`。

## 6.4 System Prompt（必须自写 — 线上那份不在任何仓内）
要点：
- 识别场景类别 → 据此定 `aspectRatio` + 分辨率（运动/风景偏 16:9，头像/图标偏 1:1…）。
- 把简短中文输入**扩写成忠实、具体的英文 prompt**；禁止无脑堆 `4K/masterpiece/cinematic`（借 `shared/api-server/routes/llm.py:15` 的"轻增强、禁风格词"约束，但加强成结构化输出）。
- 保持用户原意，不擅自加人物/场景/道具（借 `ro-story-studio/server.js:594-605` 的"锁定不新增"约束）。
- **只输出 JSON**，无解释。

## 6.5 前端数据流（替换 `src/app/AIToolPanel.tsx`）
```
右侧单一对话框输入 → POST /api/mivo/enhance
  → 展示 reasoning(深度思考) + 参数卡 + enhancedPrompt
  → 用返回参数调现有 /api/mivo/generate 或 /edit
  → commitGenerationResult 建 image node + 衍生 edge（画布，M5 已闭环）
  → 同一结果作为一条 assistant 消息进对话流（对话框，panel 内新写轻量消息列表）
```
双回流 = "同一份结果喂两个消费端"：画布走现成 `commitGenerationResult`，对话流是 panel 里新增的消息列表。

## 6.6 兜底（显式失败，不静默）
- enhance 失败 → 用原始 prompt + demo 默认参数直接生成，对话里标注"未增强，已按原文生成"。
- 返回 JSON 不合法 / 参数越界 → clamp 回现有默认 model/ratio/resolution。

## 6.7 "深度思考"展示 — 待拍板岔口
| 方案 | 做法 | 代价 | 适合 |
|---|---|---|---|
| **A. 非流式（建议先做）** | enhance 一次返回，前端先转圈"深度思考中"再一次性揭示参数卡+结果 | 最简单，近零额外工程 | demo 快速见效 |
| B. SSE 流式 | enhance 路由用 SSE 逐字推 reasoning（仿 mivo-server `api/src/ai_api/v1/service/agent.py:487-550` 的 content-item 流） | 要写 SSE + 前端流式渲染 | 想要线上"逐字深度思考"观感 |

建议先 A 后 B：A 最快复刻"输入→出参数→出图"闭环，B 只是把体验拉到线上水准，不影响功能。

## 6.8 部署
- **demo/dev 现状（就现在）**：agent 挂在 `vite.config.ts` dev middleware，**零新基建**（整个 demo 的 API 层本来就全在这，没有独立后端）。加一个 `/api/mivo/enhance` 路由即可，与 `generate/edit` 同生命周期。
- **将来生产化**：vite dev middleware 非生产服务。届时把 `/api/mivo/*` 整块抽成独立 Node/Express 服务或 serverless functions，key 永远留服务端。**现在不提前做**。
- **模型/key**：复用同一 proxy 的 chat 端点，文本增强用中档模型即可（toolbox refine 用 gpt-5.4、mivo-server 用 qwen，均可）。

## 6.9 下一步
出一份**可执行实施计划**（含 system prompt 草稿全文、`/api/mivo/enhance` 路由骨架、`AIToolPanel` 替换的组件拆分、兜底清单、验收标准）前，先探通 6.2 的 proxy chat 端点，再动实现。
