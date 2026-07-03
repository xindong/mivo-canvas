# mivo-server 提示词增强 Agent 链路清单

调研范围：只读 `/Users/praise/AI-Agent/Claude/reference/projects/mivo-server`，聚焦“对话框短提示词 -> 深度思考/场景识别 -> 自动决策模型/比例/分辨率 -> 扩写英文 prompt -> 生图 -> 回对话框和画布”这一条链路。

## 总结论

**部分找到。** mivo-server 里有真实可运行的 Agent Runtime、流式 reasoning、工具调用、图片生成工具、SSE 分发和多轮记忆链路；但截图里的具体业务表现（“深度思考结束”“场景识别: 通用运动插画”“模型: seedream 5.0 lite”“宽高比: 16:9”“分辨率: 2K”“Dynamic football kicking scene...”）没有在本地代码中找到硬编码模板或分类器。它更像是由数据库里的 `Agent.system_prompt`、`Agent.tools`、模型自身 tool calling，以及外部 Consul/运行配置共同驱动的真实实现，而不是仓内可直接复制的一段固定 prompt-enhance agent 代码。

## 1. 用户输入 -> Prompt 扩写

- `api/src/ai_api/v1/routers/agent.py:45-55` 定义 `ActionCreateRequest.prompt`，这是对话框一句短 prompt 的 HTTP 入参；`api/src/ai_api/v1/routers/agent.py:181-292` 的 `POST /agents/sessions/{session_id}/actions` 创建一轮 action。
- `api/src/ai_api/v1/routers/agent.py:214-252` 从 session/agent 读取 agent 配置，把 `agent.system_prompt` 与 `board_info_prompt` 拼成系统提示词，并把默认 board tools 与 `agent.tools` 合并后下发 worker。
- `common/src/ai_common/entity/sqlmodels/agent.py:17-59` 说明 agent 的核心契约存在数据库字段：`system_prompt`、`provider`、`model`、`temperature`、`top_p`、`default_config`、`tools`。仓内没有找到线上 `mivo_board_agent` 的真实 prompt 种子。
- `worker/src/ai_worker/tasks/agent/logic.py:61-69` 承接 API 传入的 `prompt/payload/agent_config`；`worker/src/ai_worker/tasks/agent/logic.py:114-129` 创建 `AgentRunner` 并按 `agent_config.tools` 注册工具；`worker/src/ai_worker/tasks/agent/logic.py:167-173` 调 `runner.run(prompt, stream=True, ...)`。
- `agent/src/ai_agent/mixins/content_mixin.py:59-75` 将 system prompt、图片、tools、用户 prompt、payload 一起构造成模型上下文；`agent/src/ai_agent/runner.py:519-589` 进入模型流式生成和工具调用循环。因此“扩写英文 prompt”不是一个本地独立函数，而是 LLM 在系统提示词 + 工具 schema 下生成工具参数时完成。

旁路但可参考的“润色/翻译”接口：

- `api/src/ai_api/v1/routers/tools.py:83-100` 暴露 `/tools/polish`，先 `get_polished_prompt` 再 `polish_prompt`。
- `api/src/ai_api/v1/service/prompt.py:98-129` 根据 `modelType/messageType/translate/polish/hasImage` 组装润色系统提示词；其中 `polish=True` 时设置“对提示词进行扩写”。
- `common/src/ai_common/tools/openai.py:54-75` 用 chat completion 执行 `polish_prompt(prompt, system_prompt)`。
- `common/src/ai_common/utils/smart_prompt.py:8-45` 显示模板来自 Consul `.../options/SmartPrompt/<key>`，不是仓内文件。

## 2. 深度思考 / 场景识别

- “深度思考”有真实基础设施：`agent/src/ai_agent/schema.py:27-30` 定义 `REASONING_*` agent events，`agent/src/ai_agent/schema.py:48-50` 定义 LLM reasoning events。
- 以 Qwen 为例，`agent/src/ai_agent/clients/qwen.py:399-424` 从 `reasoning_content` 提取 reasoning；`agent/src/ai_agent/clients/qwen.py:499-510` 转成 `LLMEventType.REASONING_CHUNK`。
- `agent/src/ai_agent/mixins/stream_mixin.py:72-86` 把模型文本和 reasoning chunk 分流发事件；`worker/src/ai_worker/service/agent_events.py:172-190` 将 reasoning 累积到 action 的 `thought` 并追加 `ContentItemType.REASONING`。
- `common/src/ai_common/entity/action.py:13-20` 定义 `reasoning` content item 类型，`common/src/ai_common/entity/action.py:52-67` 存 `thought/content/file_metas/tool_calls/content_items`。

未找到明确代码：没有本地函数或规则把“生成一张踢球的图”分类为“通用运动插画”。场景识别更可能是 agent system prompt 约束下的 LLM reasoning 输出，真实 prompt 可能在数据库或线上配置中。

## 3. 参数自动决策：模型 / 宽高比 / 分辨率

- Agent 层的“模型选择”首先来自数据库配置：`common/src/ai_common/entity/sqlmodels/agent.py:34-55` 的 `provider/model/default_config/tools`。API 允许单次 action 用 `modelName` 覆盖默认模型：`api/src/ai_api/v1/routers/agent.py:244-252`。
- 工具选择来自 tool calling：`agent/src/ai_agent/tools/__init__.py:16-33` 动态加载 `ai_agent.tools.<path>`，`agent/src/ai_agent/tools/__init__.py:62-75` 注册到 runner；`agent/src/ai_agent/builder/tool.py:250-306` 从函数签名生成 JSON Schema 参数，`agent/src/ai_agent/builder/tool.py:309-385` 的 `@tool` 装饰器生成 tool 类。
- Qwen adapter 会把工具描述与参数 schema 传给模型：`agent/src/ai_agent/builder/adapter/qwen.py:64-94` 转成 function calling 结构，`agent/src/ai_agent/builder/adapter/qwen.py:96-122` 放进生成 config；Qwen 请求默认 `tool_choice="auto"`：`agent/src/ai_agent/clients/qwen.py:136-145`。
- Seedream agent 图片工具的参数由 LLM 决策：`agent/src/ai_agent/tools/images/seedream.py:13-24` 定义 `generate_image_seedream_pro(prompt,title,width,height,...)`，描述“根据提示词生成图片，支持分辨率和宽高比”；`agent/src/ai_agent/builder/tool_params.py:3-5` 给 `title/width/height` 的参数说明。
- Seedream 工具只接 `width/height`，没有仓内场景 -> ratio -> resolution 的确定性映射表；`agent/src/ai_agent/tools/images/seedream.py:50-55` 只校验 `width * height >= 921600`。
- Ark Seedream 底层确有 `Seedream_5_0_lite` 枚举：`common/src/ai_common/tools/ark.py:101-104`；`ImageSeedream` 从 `volcengineARK.image_model` 配置取默认模型：`common/src/ai_common/tools/ark.py:115-122`，调用时用 `_resolve_model`：`common/src/ai_common/tools/ark.py:124-131`。请求最终把 `model/prompt/image/size` 交给 Ark Images API：`common/src/ai_common/tools/ark.py:154-168`。
- `config.example.yaml:111-116` 的示例默认 `image_model` 是 `doubao-seedream-4-0-250828`，不是 5.0 lite；所以截图中的 `seedream 5.0 lite` 应来自线上配置或 agent prompt 决策，仓内没有固定路由。

与 demo 更相关的 gpt-image-2 agent tool：

- `agent/src/ai_agent/tools/images/openai.py:19-46` 有 gpt-image-2 的 `aspect_ratio + quality -> size` 映射；`agent/src/ai_agent/tools/images/openai.py:110-140` 定义 `generate_image_openai_pro(prompt,title,image_urls,aspect_ratio,quality,output_format)`；`agent/src/ai_agent/tools/images/openai.py:160-190` 根据是否有参考图调用 `edit_image` 或 `generate_image`。
- 这是真实工具实现，但仍依赖 mivo-server 的 OSS/FileMeta/credential 链路；MivoCanvas demo 直连 `/api/mivo/generate|edit` 时只能复用参数形状和映射思想，不能直接搬运行时。

## 4. 触发图像生成

Seedream 路线：

- `agent/src/ai_agent/tools/images/seedream.py:56-64` 解析参考图 URL，构造 `SeedreamRequest(prompt,image,size=f"{width}x{height}")`，调用 `ImageSeedream().generate(req)`。
- `common/src/ai_common/tools/ark.py:154-168` 构造 Ark `client.images.generate` 参数：`model`、`prompt`、`image`、`size`、`response_format="url"`、`watermark=False`。
- `agent/src/ai_agent/tools/images/seedream.py:72-93` 取返回 URL 并保存到 OSS；`agent/src/ai_agent/tools/images/seedream.py:94-102` 返回 `FunctionCallResult(success=True, text="生成图片成功...", file_metas=[...], metadata=...)`。

gpt-image-2 路线：

- `agent/src/ai_agent/tools/images/openai.py:151-180` 有参考图时把 URL 转文件后走 `edit_image(...)`；`agent/src/ai_agent/tools/images/openai.py:181-190` 无参考图时走 `generate_image(...)`；`agent/src/ai_agent/tools/images/openai.py:197-239` 保存 base64 结果并返回 file_metas。

## 5. 结果分发：回对话框 / 画布

- Worker 注册事件处理：`worker/src/ai_worker/tasks/agent/logic.py:131-149` 将 `MESSAGE_CHUNK`、`REASONING_CHUNK`、`TOOL_CALL`、`TOOL_RESULT`、`IMAGE_CHUNK` 等事件绑定到 action 持久化逻辑。
- 文本/思考/工具结果进入 action：`worker/src/ai_worker/service/agent_events.py:151-190` 保存文本和 reasoning content items；`worker/src/ai_worker/service/agent_events.py:224-299` 保存 tool call/result，并把工具返回的 file_metas 写入 action。
- 图片 chunk 路线：`worker/src/ai_worker/service/agent_events.py:301-388` 将模型直接流出的图片保存成 FileMeta 并追加 `FILE_META` content item。
- action 完成时，`worker/src/ai_worker/service/agent_events.py:414-456` 把 action 上的 file_meta ids 合并进 assistant message，或保存一个空 assistant attachment message。
- 前端订阅点是 `api/src/ai_api/v1/routers/agent.py:295-347` 的 SSE；`api/src/ai_api/v1/service/agent.py:487-550` 轮询 action 并发送累计 `content_items/tool_calls/content/file_metas/status/payload`。
- mivo-server 后端没有在本仓看到“把图片节点插到画布”的 React/Canvas 代码；它能确认的是对话流里会发 `file_metas`，且 action/session 带 `board_id` 上下文：`api/src/ai_api/v1/service/agent.py:578-588`。结果同时呈现在“对话框和画布”的最后一步应由前端消费 SSE 后建画布节点，本仓无法完全确认。

## 6. 会话 / 多轮状态

- 默认 agent key 是 `mivo_board_agent`：`api/src/ai_api/v1/service/agent.py:45-47`；创建 session 时如果没有指定 agent，按这个 key 取 agent：`api/src/ai_api/v1/service/agent.py:94-113`。
- session 表绑定用户、board、agent：`common/src/ai_common/entity/sqlmodels/agent_session.py:15-43`；输出 schema 可带 messages 和 usage：`common/src/ai_common/entity/sqlmodels/agent_session.py:58-70`。
- message 表存一轮中的 user/assistant/tool 片段、tool_calls、thought、file_metas：`common/src/ai_common/entity/sqlmodels/agent_message.py:24-52`，输出时 file_meta ids 会解析成 BaseFileMeta：`common/src/ai_common/entity/sqlmodels/agent_message.py:90-150`。
- Worker 使用 PostgreSQL memory：`worker/src/ai_worker/tasks/agent/logic.py:96-104`；`agent/src/ai_agent/memory/memory_manager.py:46-75` 管理 backend/session/user/max_history，`agent/src/ai_agent/memory/memory_manager.py:125-158` 提供 save/get_history。
- PostgreSQL backend 写 AgentMessage：`agent/src/ai_agent/memory/postgresql.py:42-70`；按 action_id 取最近历史并转回模型历史：`agent/src/ai_agent/memory/postgresql.py:258-284`。
- Runner 初始化时保存用户消息：`agent/src/ai_agent/runner.py:428-449`；每轮会加载历史插回模型上下文：`agent/src/ai_agent/mixins/content_mixin.py:76-87`；工具调用和工具响应也会写 memory：`agent/src/ai_agent/mixins/memory_mixin.py:121-222`。

## 真实性与缺口

- 真实实现：Agent HTTP API、TaskIQ worker、AgentRunner、多轮 memory、reasoning stream、tool calling、Seedream/gpt-image-2 图片工具、SSE action 分发都是仓内真实代码。
- 原型/测试占位：`api/tests/v1/routers/test_agent_action_sse.py:98-105` 会创建一个测试用 `mivo_board_agent`，system prompt 只是“有用的助手, 灵活使用工具”，不能代表线上提示词增强 agent。
- 未找到：截图中的 exact 示例 prompt `Dynamic football kicking scene...`、中文“通用运动插画”、中文“深度思考结束”、确定性的场景分类器、确定性的“踢球 -> 16:9 -> 2K -> Seedream 5.0 lite”代码链路。
- 关键原因：真实业务规则大概率在 DB `agents.system_prompt/tools/default_config` 和 Consul `SmartPrompt`/运行配置里；仓内 CLI 也支持线上手工编辑 system prompt/tools：`cli/agent.py:251-298`，`cli/agent.py:382-435`。

## 可复用 / 需重写

可复用：

- 把 mivo-server 的 agent 交互抽象成 MivoCanvas 本地 contract：短 prompt + 可选参考图 -> `scene/model/aspect_ratio/quality_or_resolution/expanded_prompt/title`。代码证据是 `Agent.system_prompt/tools` 配置化和 tool schema 让 LLM 决策参数：`common/src/ai_common/entity/sqlmodels/agent.py:17-59`、`agent/src/ai_agent/builder/tool.py:250-385`。
- 复用 gpt-image-2 参数映射：`agent/src/ai_agent/tools/images/openai.py:19-63` 的 `aspect_ratio + quality -> size` 与本 demo `/api/mivo/generate|edit` 的 `size` 参数契约一致。
- 复用“流式内容项”思想：text/reasoning/tool_call/tool_result/file_meta 分开展示，参考 `common/src/ai_common/entity/action.py:13-20`、`api/src/ai_api/v1/service/agent.py:487-550`。
- 复用独立 prompt polish 的思路，但要自带模板：`api/src/ai_api/v1/service/prompt.py:98-129` + `common/src/ai_common/tools/openai.py:54-75`。

需重写 / 适配：

- 不建议把 mivo-server 整套接进 MivoCanvas demo：它依赖 FastAPI、TaskIQ、Mongo/PostgreSQL、OSS/FileMeta、JWT、Consul/配置中心，和当前 demo “React + Node 中间件直连 llm-proxy gpt-image-2 同步”不一致。
- 需要在 MivoCanvas 新写一个轻量 `AIToolPanel` 替换层：右侧对话输入短 prompt -> 调一个本地 prompt-enhance API 或前端可控 JSON schema -> 再调用现有 `/api/mivo/generate|edit`；生图结果仍走本地 IndexedDB + `commitGenerationResult` 建节点/edge。
- 需要显式本地化 system prompt/template，因为线上 `mivo_board_agent` 的真实系统提示词和 SmartPrompt 模板不在仓内。
- 需要把 seedream 的 `width/height` 决策改成 demo 的 `imgRatio/quality/size` 决策；Seedream OSS/FileMeta 保存逻辑不能直接搬。
- 如果要展示“深度思考结束 / 场景识别 / 模型 / 宽高比 / 分辨率”，MivoCanvas 应要求 LLM 先返回结构化 JSON，再用 UI 渲染这些字段；mivo-server 仓内没有可直接复制的固定 scene classifier。

净结论：mivo-server 里找到的是**真实 agent 基建 + 图片工具链路**，但截图里“提示词增强 agent”的核心业务 prompt/分类规则未落在仓内；MivoCanvas 不应接 mivo-server，只应抄 gpt-image-2 size 映射、tool schema 思路和 streaming content item 展示模式，并重写一个本地轻量 prompt-enhance -> `/api/mivo/generate|edit` 适配层。
