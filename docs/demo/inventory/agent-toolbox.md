# XD-AIGC-toolbox 提示词增强 agent 功能清单

盘点目标：只看 `/Users/praise/AI-Agent/Claude/reference/projects/XD-AIGC-toolbox` 中“用户短提示词 -> LLM/agent 扩写/增强 -> 再生图”的链路。未改参考仓源码，未触碰 `_tmp/`。

## 总结

- 找到 1 条最接近目标的真实链路：`tools/ro-story-studio`，在生图前提供“描述润色”按钮，调用 `/api/refine-prompt`，由 LLM 把剧情描述改写成更适合单帧故事版的动作/表情描述，再把润色后的文本作为 `scene` 进入 Mivo Hub 图像生成。
- 找到 1 条可复用但能力较轻的 shared 链路：`shared/api-server/routes/llm.py` + `tools/flux-svg`，对中文 prompt 做英文翻译并轻量增强，再进入 ComfyUI 工作流。
- 没找到线上 Mivo 描述的完整 agent 形态：没有“深度思考/场景识别 -> 自动选模型+宽高比+分辨率 -> rich English prompt -> 同时入对话和画布”的完整实现。现有代码里模型、比例、分辨率多由 UI 下拉或硬编码决定。

## 精确命中：`tools/ro-story-studio`

### `tools/ro-story-studio/public/index.html`

路径 -> 职责 -> 关键导出/接口/类型 -> 代码现状 -> 依赖与数据流 -> 闭环状态

- `tools/ro-story-studio/public/index.html:1240` -> 聊天输入区里的润色状态条和按钮入口 -> `refineBar`、`refineBtn`、`refinePromptClick()` -> 真实 UI，按钮文案为“描述润色”，title 明确是“用 AI 扩写动作描述” (`tools/ro-story-studio/public/index.html:1248`) -> 调用同页的 refine 逻辑，再写回 `sceneInput` -> **真实可用，但不是自动触发**，需要用户点击。
- `tools/ro-story-studio/public/index.html:2837` -> Prompt 润色前端状态与交互 -> `refineState`、`clearRefineState()`、`refinePromptClick()` -> 真实前端逻辑；会要求已有剧情文本和至少一个角色 (`tools/ro-story-studio/public/index.html:2848`, `tools/ro-story-studio/public/index.html:2854`) -> 收集 `selectedChars` 与 `selectedScene` 后 POST `api/refine-prompt` (`tools/ro-story-studio/public/index.html:2868`, `tools/ro-story-studio/public/index.html:2875`) -> **真实 prompt enhancement 链路入口**。
- `tools/ro-story-studio/public/index.html:2883` -> 润色结果落回输入框 -> `refineState.original/refined/isRefined`、`setSceneTokenizedText(data.refined)` -> LLM 返回后会保存原文/润色文，并直接替换当前剧情输入 (`tools/ro-story-studio/public/index.html:2887`) -> 后续 `send()` 读取 `getSceneText()` (`tools/ro-story-studio/public/index.html:2930`) -> **闭环成立：增强文本成为生图输入**。
- `tools/ro-story-studio/public/index.html:2951` -> 单角色生图请求 -> `doGenerate(scene, style, charId, ratioOverride, resolutionOverride)` -> 真实生图入口；读取 UI 里的 ratio/resolution/shot/angle (`tools/ro-story-studio/public/index.html:2972`) -> 根据 `imageModel` 选 `api/generate` 或 `api/generate-gpt` (`tools/ro-story-studio/public/index.html:2979`) -> **模型/尺寸来自 UI 选择，不是 agent 自动决策**。
- `tools/ro-story-studio/public/index.html:3023` -> 多角色融合生图请求 -> `doGenerateFusion(...)` -> 真实生图入口；同样读取 ratio/resolution/shot/angle (`tools/ro-story-studio/public/index.html:3042`) -> 根据 `imageModel` 选 `api/generate-fusion` 或 `api/generate-gpt-fusion` (`tools/ro-story-studio/public/index.html:3057`) -> **多角色 prompt 拼装由前后端模板完成，不是 LLM 自动扩写**。
- `tools/ro-story-studio/public/index.html:2228` -> 生图模型与质量/分辨率 UI 状态 -> `imageModel`、`IMAGE_MODEL_LABEL`、`RES_OPTIONS` -> 模型包含 `nano` 与 `gpt`，默认强制为 `nano` (`tools/ro-story-studio/public/index.html:2232`)；Nano 用 1K/2K/4K，GPT 用 low/medium/high (`tools/ro-story-studio/public/index.html:2239`) -> 被 `doGenerate`/`doGenerateFusion` 读取 -> **参数选择是 UI 决策，不是场景识别**。

### `tools/ro-story-studio/server.js`

路径 -> 职责 -> 关键导出/接口/类型 -> 代码现状 -> 依赖与数据流 -> 闭环状态

- `tools/ro-story-studio/server.js:18` -> LLM 润色服务配置 -> `REFINE_API_ENDPOINT`、`REFINE_API_KEY`、`REFINE_MODEL` -> 真实外部 LLM 配置；默认模型为 `gpt-5.4` (`tools/ro-story-studio/server.js:20`) -> 被 `refinePrompt()` 使用 -> **需要环境变量，否则 `/api/refine-prompt` 报错**。
- `tools/ro-story-studio/server.js:576` -> LLM prompt 增强核心函数 -> `async function refinePrompt({ prompt, characters, scene })` -> 真实 LLM 调用；会把已选角色名和场景名注入 system prompt (`tools/ro-story-studio/server.js:580`) -> 被 `/api/refine-prompt` 调用 (`tools/ro-story-studio/server.js:1031`) -> **这是最明确的 prompt enhancement agent**。
- `tools/ro-story-studio/server.js:586` -> 系统提示词模板 -> system prompt 定位为“单帧画面的「动作 + 表情翻译器」” -> 模板要求把剧情描述翻译成“身体姿态 + 表情情绪”，保留中心思想，不增加上下文；锁定角色关系，禁止新增外观、环境、视线、心理活动、新角色/新道具/新场景 (`tools/ro-story-studio/server.js:590`, `tools/ro-story-studio/server.js:594`, `tools/ro-story-studio/server.js:605`) -> 输出中文、精简、无解释 (`tools/ro-story-studio/server.js:615`) -> **对故事版动作很有用，但不符合目标中的 rich English prompt**。
- `tools/ro-story-studio/server.js:617` -> LLM chat completions 调用点 -> `fetch(REFINE_API_ENDPOINT)`，body 内 `messages: [{role:'system'}, {role:'user'}]` (`tools/ro-story-studio/server.js:623`) -> temperature 0.3、max_tokens 400 (`tools/ro-story-studio/server.js:629`) -> 返回结果给前端 -> **真实外部 LLM-in-loop**。
- `tools/ro-story-studio/server.js:1031` -> Prompt 润色 HTTP endpoint -> `POST /api/refine-prompt` -> 校验 prompt 非空，调用 `refinePrompt`，返回 `{ original, refined }` (`tools/ro-story-studio/server.js:1039`, `tools/ro-story-studio/server.js:1042`) -> 前端拿 `refined` 替换输入 -> **闭环成立**。
- `tools/ro-story-studio/server.js:398` -> Mivo Hub 生图客户端 -> `generateImage({ prompt, images, ratio, resolution, modelType, modelVersion, quality })` -> 构造 `payload = { prompt, imgRatio, resolution, n: 1 }`，可附 `quality` 与 `images` (`tools/ro-story-studio/server.js:402`, `tools/ro-story-studio/server.js:418`) -> POST `${MIVO_ENDPOINT}/api/v1/message`，`messageType:'image'`，`action:'mcp'` (`tools/ro-story-studio/server.js:424`, `tools/ro-story-studio/server.js:428`) -> **这是 prompt 增强后进入图像生成的最终发送结构**。
- `tools/ro-story-studio/server.js:754` -> Nano 单角色生图 endpoint -> `POST /api/generate` -> 拼 `fullPrompt = shotAngleHead + charsBlock + charPrompt + propConstraint + sceneConstraint + resolvedStylePrompt + scene` (`tools/ro-story-studio/server.js:756`, `tools/ro-story-studio/server.js:763`) -> 调 `submitQueuedGeneration({ prompt: fullPrompt, images, ratio, resolution })` (`tools/ro-story-studio/server.js:782`) -> **scene 可能是 LLM 润色后的文本；最终 prompt 是模板拼装**。
- `tools/ro-story-studio/server.js:799` -> Nano 多角色融合 endpoint -> `POST /api/generate-fusion` -> 根据角色参考图、道具、场景、风格、景别、视角、剧情拼 `fullPrompt` (`tools/ro-story-studio/server.js:806`, `tools/ro-story-studio/server.js:816`) -> 调 Mivo 生成 (`tools/ro-story-studio/server.js:833`) -> **真实多图参考生成，增强只覆盖剧情 scene 段**。
- `tools/ro-story-studio/server.js:850` -> GPT 单角色 endpoint -> `POST /api/generate-gpt` -> 拼 prompt 逻辑同 Nano，但 `submitQueuedGeneration` 传 `modelType: MIVO_GPT_IMAGE_TYPE`、`modelVersion: MIVO_GPT_IMAGE_VERSION`、`quality` (`tools/ro-story-studio/server.js:875`) -> 默认 GPT 配置在 `tools/ro-story-studio/server.js:24` -> **模型由 UI 选择，服务端不自动判断**。
- `tools/ro-story-studio/server.js:897` -> GPT 多角色融合 endpoint -> `POST /api/generate-gpt-fusion` -> 多角色拼 prompt，并传 GPT 模型参数 (`tools/ro-story-studio/server.js:929`) -> **真实链路，非 agent 自动决策**。
- `tools/ro-story-studio/server.js:220` -> 风格 prompt 选择 -> `resolveStylePrompt(style, imageModel)` -> 同一 style 针对 Nano/GPT 可选择不同文案 (`tools/ro-story-studio/server.js:222`) -> 被四个 generate endpoint 使用 -> **有“按模型切 prompt”的雏形，但模型本身不是自动选**。

### ro-story-studio 流程图

1. 用户在聊天输入框写短剧情。
2. 点击“描述润色”：`public/index.html:2848` -> POST `api/refine-prompt` (`public/index.html:2875`)。
3. Node 服务 `POST /api/refine-prompt` (`server.js:1031`) -> `refinePrompt()` (`server.js:576`) -> 外部 LLM chat completions (`server.js:617`)。
4. 返回 `{ original, refined }` (`server.js:1042`) -> 前端 `setSceneTokenizedText(data.refined)` (`public/index.html:2887`)。
5. 用户发送：`send()` 读取当前输入 (`public/index.html:2930`) -> 单角色/多角色生成 (`public/index.html:2943`)。
6. 前端按 UI 模型选择调用 `api/generate` / `api/generate-gpt` / fusion 端点 (`public/index.html:2979`, `public/index.html:3057`)。
7. 服务端模板拼 `fullPrompt` (`server.js:763`, `server.js:816`, `server.js:859`, `server.js:914`) -> Mivo Hub `/api/v1/message` (`server.js:424`)。

闭环判断：**真实链路，功能部分命中**。它是“短剧情 -> LLM 动作/表情润色 -> Mivo 生图”，但不是“深度场景识别 -> 自动模型/比例/分辨率 -> rich English prompt”。

## Shared 轻增强链路：`shared/api-server` + `tools/flux-svg`

### `shared/api-server/routes/llm.py`

路径 -> 职责 -> 关键导出/接口/类型 -> 代码现状 -> 依赖与数据流 -> 闭环状态

- `shared/api-server/routes/llm.py:13` -> 通用 LLM 路由 -> `router = APIRouter(prefix="/llm")` -> 真实 FastAPI route -> 被 `shared/api-server/main.py` 自动注册 (`shared/api-server/main.py:71`) -> **shared 可复用入口**。
- `shared/api-server/routes/llm.py:15` -> prompt 模板 -> `_TRANSLATE_SYSTEM` -> 明确要求 “Translate the user's text into English and lightly enhance it for image generation”，保留核心主体，可加 1-3 个自然视觉形容词，禁止 cinematic/digital art/photorealistic/dramatic lighting 等风格词，只输出一个短句 (`shared/api-server/routes/llm.py:16`, `shared/api-server/routes/llm.py:19`, `shared/api-server/routes/llm.py:21`, `shared/api-server/routes/llm.py:23`) -> **这是可复用的英文翻译+轻增强提示词模板**。
- `shared/api-server/routes/llm.py:31` -> 通用翻译增强 endpoint -> `POST /llm/translate` -> 调 `chat(messages=[system,user], max_tokens=200, temperature=0.3)` (`shared/api-server/routes/llm.py:38`) -> 返回 `{ original, translated }` (`shared/api-server/routes/llm.py:46`) -> **真实 LLM 调用，但增强力度很轻**。

### `shared/api-server/lib/nova_client.py`

- `shared/api-server/lib/nova_client.py:1` -> Nova LLM Proxy 封装 -> `PROMPT_API_HOST`、`PROMPT_API_KEY`、`PROMPT_API_MODEL` -> 使用 OpenAI-compatible `OpenAI(base_url=_HOST, api_key=_KEY)` (`shared/api-server/lib/nova_client.py:21`) -> `chat(messages, model, **kwargs)` 返回 `choices[0].message.content.strip()` (`shared/api-server/lib/nova_client.py:28`) -> **可复用 Python LLM 调用封装；需要迁移/重写才能直接进 MivoCanvas React/Vite Node 层**。

### `tools/flux-svg/index.html`

- `tools/flux-svg/index.html:149` -> T2I prompt 输入区 -> “提示词（支持中文）” -> 真实前端输入 -> `onPromptInput()` 做自动翻译检测 (`tools/flux-svg/index.html:152`) -> **轻增强入口**。
- `tools/flux-svg/index.html:289` -> 中文检测与 debounce -> `hasChinese()`、`onPromptInput()` -> 仅中文触发，800ms 后 `doTranslate(text)` (`tools/flux-svg/index.html:297`, `tools/flux-svg/index.html:299`) -> **不是通用 prompt agent，只是中文自动翻译增强**。
- `tools/flux-svg/index.html:308` -> 调 shared LLM endpoint -> `fetch(`${API}/llm/translate`)` -> 保存 `translatedText = data.translated` (`tools/flux-svg/index.html:317`) -> **真实调用 shared LLM**。
- `tools/flux-svg/index.html:406` -> 生图前选择最终 prompt -> 如果有 `translatedText`，`promptFinal = translatedText`；否则使用原文 (`tools/flux-svg/index.html:407`, `tools/flux-svg/index.html:411`, `tools/flux-svg/index.html:414`) -> **增强结果进入生图链路**。
- `tools/flux-svg/index.html:442` -> ComfyUI workflow 注入 -> `wf['27'].inputs.value = promptFinal`，宽高来自 `resVal` 且固定正方形 (`tools/flux-svg/index.html:450`, `tools/flux-svg/index.html:456`) -> `submitWorkflow(wf)` POST `${COMFYUI}/api/prompt` (`tools/flux-svg/index.html:506`) -> **闭环真实，但目标不是 Mivo Hub，而是 ComfyUI SVG 工作流**。
- `shared/api-server/routes/flux_svg.py:1` -> Flux SVG 后端占位模块 -> 注释说明 prompt translation 由 shared `/api/llm/translate` 处理 (`shared/api-server/routes/flux_svg.py:3`) -> **说明 shared route 是设计上的公共能力**。

闭环判断：**真实链路，部分命中**。它是“中文短 prompt -> LLM 英文翻译+轻增强 -> ComfyUI 生图”，没有场景识别、自动模型/比例/分辨率，也不是 Mivo 图像生成端点。

## 相关但未命中的 LLM-in-loop / prompt 拼装

这些工具有 LLM 或 prompt 模板，但没有确认存在“生图前把用户短 prompt 扩写成生图 prompt”的链路。

### `tools/operation-image-translator`

- `tools/operation-image-translator/server.js:275` -> 视觉模型识别海报文字 -> `extractTextFromImage(buffer, ext)` -> 使用视觉 LLM 提取文字 JSON (`tools/operation-image-translator/server.js:281`, `tools/operation-image-translator/server.js:299`) -> **LLM 用于读图/OCR 分类，不是 prompt 扩写**。
- `tools/operation-image-translator/server.js:424` -> 翻译图 prompt 拼装 -> `buildTranslationPrompt(...)` -> deterministic 模板，把模式、目标语言、文本块、比例拼成 Mivo 图像 prompt (`tools/operation-image-translator/server.js:437`, `tools/operation-image-translator/server.js:496`) -> **模板生成，不是 LLM 增强**。
- `tools/operation-image-translator/server.js:516` -> 海报 V2 prompt 拼装 -> `buildPosterV2Prompt(...)` -> 由用户字段、参考图、构图类型、随机 hint 拼 prompt (`tools/operation-image-translator/server.js:547`, `tools/operation-image-translator/server.js:589`) -> **有自动拼装/随机风格提示，但不是 LLM agent**。
- `tools/operation-image-translator/server.js:167` -> Mivo Hub 图像生成 -> payload `{ prompt, imgRatio, resolution, n }`，POST `/api/v1/message` (`tools/operation-image-translator/server.js:188`) -> 被海报生成和翻译任务调用 (`tools/operation-image-translator/server.js:639`, `tools/operation-image-translator/server.js:752`) -> **可参考 Mivo 请求结构，但不是 prompt enhancement**。

### `tools/xd-fashion-trend-studio`

- `tools/xd-fashion-trend-studio/lib/prompts.js:37` -> 固定换装 prompt -> `OUTFIT_TRANSFER_PROMPT_ZH`、`OUTFIT_TRANSFER_3D_PROMPT_ZH` -> 规则型中文 prompt 常量 (`tools/xd-fashion-trend-studio/lib/prompts.js:48`) -> **不是 LLM 扩写**。
- `tools/xd-fashion-trend-studio/lib/outfit-runner.js:74` -> 生图前选固定 prompt -> 按 `kind` 选择 2D/3D prompt，然后 `mivo.generateImage({ prompt, images, ratio, resolution })` (`tools/xd-fashion-trend-studio/lib/outfit-runner.js:81`) -> **没有用户 prompt -> LLM 增强步骤**。
- `tools/xd-fashion-trend-studio/lib/auto-detect.js:12` -> 视觉 LLM 检测模特 bbox/性别/风格关键词 -> system prompt 要求 JSON 输出 (`tools/xd-fashion-trend-studio/lib/auto-detect.js:16`) -> chat body 使用 `messages` 和图片 (`tools/xd-fashion-trend-studio/lib/auto-detect.js:65`) -> **LLM 用于图像分析，不是增强 prompt**。

### `tools/xd-town-hair-generator`

- `tools/xd-town-hair-generator/lib/prompts.js:29` -> 发型生成 deterministic prompt builder -> `buildSketchPrompt` 等模板 -> 大段硬约束 prompt (`tools/xd-town-hair-generator/lib/prompts.js:31`) -> **不是 LLM 扩写**。
- `tools/xd-town-hair-generator/lib/style-transfer-runner.js:47` -> 生图前选模板 prompt -> `getPrompt(templateKind, { view })`，`getRatio()`，`getResolution()` (`tools/xd-town-hair-generator/lib/style-transfer-runner.js:50`) -> `mivo.generateImage({ prompt, images, ratio, resolution })` (`tools/xd-town-hair-generator/lib/style-transfer-runner.js:59`) -> **参数来自模板类型/视角，不是 agent 自动决策**。
- `tools/xd-town-hair-generator/lib/auto-detect.js:11` -> 视觉 LLM 检测发型 bbox/性别/关键词/视角 -> system prompt 要求 JSON (`tools/xd-town-hair-generator/lib/auto-detect.js:16`) -> chat body 使用图片与文本 (`tools/xd-town-hair-generator/lib/auto-detect.js:78`) -> **场景/对象识别雏形存在，但输出用于裁剪/分类，不用于扩写用户 prompt**。

### `tools/xd-town-tittle-translation`

- `tools/xd-town-tittle-translation/server.js:165` -> 最终 prompt 拼装 -> `buildPrompt({ targetLang, targetText })` -> 只对 `rules.md` 模板做 `TARGET_LANGUAGE/TARGET_TEXT` 变量替换 (`tools/xd-town-tittle-translation/server.js:169`) -> **不是 LLM 扩写**。
- `tools/xd-town-tittle-translation/server.js:294` -> 视觉 LLM 预分析字体特征 -> `analyzeRefFontFeatures(refImgPath)` -> 使用视觉模型输出字体画像 JSON (`tools/xd-town-tittle-translation/server.js:307`, `tools/xd-town-tittle-translation/server.js:323`) -> 注释说可注入 prompt，但主生成链路里未看到调用；实际主流程直接 `currentPrompt = buildPrompt(...)` (`tools/xd-town-tittle-translation/server.js:622`) -> **分析能力有雏形，是否接入生图未确认**。
- `tools/xd-town-tittle-translation/server.js:606` -> 比例选择 -> `size === 'auto'` 时直接使用 `'16:9'`，否则 `sizeToRatio(size)` (`tools/xd-town-tittle-translation/server.js:606`) -> **不是智能比例识别**。
- `tools/xd-town-tittle-translation/mivo-client.js:72` -> Mivo Hub 请求结构 -> payload `{ prompt, imgRatio, resolution, n }`，可带 `quality/background/images` (`tools/xd-town-tittle-translation/mivo-client.js:75`) -> POST `/api/v1/message` (`tools/xd-town-tittle-translation/mivo-client.js:85`) -> **可参考请求结构，不是 prompt enhancement**。

### `tools/xd-town-design-check`

- `tools/xd-town-design-check/src/app/api/review/route.ts:100` -> 审图 prompt 拼装 -> `buildPromptBody(...)` 把项目规范、分类 spec、stage 模板拼成 AI 审图 prompt (`tools/xd-town-design-check/src/app/api/review/route.ts:112`) -> **是审图/评分，不是生图**。
- `tools/xd-town-design-check/src/app/api/review/route.ts:195` -> 审图请求前拼 scoped prompt -> 加类别强制约束和真实参考图识别结果 (`tools/xd-town-design-check/src/app/api/review/route.ts:220`, `tools/xd-town-design-check/src/app/api/review/route.ts:383`) -> 调 `callVisionAI` (`tools/xd-town-design-check/src/app/api/review/route.ts:395`) -> **没有 Mivo 生图链路**。
- `tools/xd-town-design-check/src/lib/ai/provider.ts:289` -> OpenAI-compatible 视觉 LLM 调用 -> `messages = [{ role: "user", content: buildContent(request) }]`，POST `/chat/completions` (`tools/xd-town-design-check/src/lib/ai/provider.ts:290`, `tools/xd-town-design-check/src/lib/ai/provider.ts:302`) -> **可借鉴多模态审图封装，但不属于 prompt 增强生图 agent**。

## 场景识别 / 参数自动决策现状

- `ro-story-studio` 有已选角色/场景上下文注入 refine system prompt (`tools/ro-story-studio/server.js:580`)，但没有让 LLM 输出 scene type、模型、比例、分辨率。模型来自 `imageModel` 本地状态 (`tools/ro-story-studio/public/index.html:2237`)，比例和分辨率/质量来自 dropdown (`tools/ro-story-studio/public/index.html:2972`)。
- `ro-story-studio` 服务端会按 `imageModel` 选择不同 style prompt (`tools/ro-story-studio/server.js:220`)，这是“模型相关 prompt 变体”，不是自动选模型。
- `flux-svg` 只检测是否包含中文来决定是否调用翻译 (`tools/flux-svg/index.html:290`)，宽高固定取同一个 `resVal` (`tools/flux-svg/index.html:456`)。
- `xd-town-hair-generator`、`xd-fashion-trend-studio` 有视觉 LLM 做 bbox/性别/关键词/视角分析 (`tools/xd-town-hair-generator/lib/auto-detect.js:11`, `tools/xd-fashion-trend-studio/lib/auto-detect.js:12`)，但这些输出服务于裁剪、分类、UI 标签或模板选择，不是“用户文本场景识别 -> prompt/参数自动决策”。
- `xd-town-tittle-translation` 的 `size === 'auto'` 当前实际落到固定 `'16:9'` (`tools/xd-town-tittle-translation/server.js:606`)，不能视为自动比例决策。

## Shared 可复用封装

- 可复用 LLM 调用封装：`shared/api-server/lib/nova_client.py:28` 的 `chat(messages, model=None, **kwargs)`，通过 `PROMPT_API_HOST/PROMPT_API_KEY/PROMPT_API_MODEL` 配置 (`shared/api-server/lib/nova_client.py:1`)。
- 可复用 prompt 增强模板：`shared/api-server/routes/llm.py:15` 的 `_TRANSLATE_SYSTEM`，适合作为“中文 -> 英文生图短 prompt”的基线，但目标 MivoCanvas 需要更强的结构化输出。
- 可复用 HTTP API 形态：`POST /llm/translate` (`shared/api-server/routes/llm.py:31`) 返回 `{ original, translated }`，容易被前端接入。
- 限制：shared 是 Python FastAPI；MivoCanvas 当前是 React/Vite/Node 中间层，若直接替换 `src/app/AIToolPanel.tsx`，需要迁移成 Vite 中间层/Node route，或单独部署 shared API 后由前端/Node 调用。

## 可复用 / 需重写：用于替换 MivoCanvas `src/app/AIToolPanel.tsx`

### 可复用

- `ro-story-studio` 的 refine 链路形态可复用：前端“增强中/查看原文/撤销”状态、`{ original, refined }` 返回结构，以及增强后替换输入再生图的闭环 (`tools/ro-story-studio/public/index.html:2837`, `tools/ro-story-studio/public/index.html:2883`)。
- `ro-story-studio` 的动作/表情 system prompt 适合作为“单帧角色动作约束”参考，尤其是关系锁定、禁止新增外观/环境/道具的规则 (`tools/ro-story-studio/server.js:594`, `tools/ro-story-studio/server.js:605`)。
- `shared/api-server/routes/llm.py` 的英文翻译+轻增强规则可作为 MivoCanvas “输出英文 prompt” 的起点 (`shared/api-server/routes/llm.py:15`)。
- Mivo Hub 请求结构可复用为后端生成 API 参考：`messageType:'image'`、`action:'mcp'`、`payload:{ prompt,imgRatio,resolution,n,images?,quality? }` (`tools/ro-story-studio/server.js:398`, `tools/ro-story-studio/server.js:424`)。

### 需重写

- 需要重写成 MivoCanvas 自己的 React 状态与画布数据流：toolbox 的 `ro-story-studio` 是单页原生 DOM；MivoCanvas 要接 `src/app/AIToolPanel.tsx`、canvas store、node/edge 创建、生成结果入画布。
- 需要重写 prompt agent 输出结构：目标应让 LLM 输出英文 rich prompt，并可结构化给出 `model`、`aspectRatio`、`resolution`、`mode`、`reasoning/sceneType`；现有 `ro-story-studio` 只输出中文动作描述，`flux-svg` 只输出短英文 phrase。
- 需要重写自动参数决策：现有 toolbox 没有完整“自动选模型+宽高比+分辨率”的实现；MivoCanvas 若要线上 Mivo 形态，需要新增 schema 和校验，例如 `{ enhancedPrompt, model, aspectRatio, resolution, sizeReason, safetyNotes }`。
- 需要重写生成结果回流：toolbox 结果进入各工具自己的历史/聊天 UI；MivoCanvas 目标是右侧工具栏触发后同时进入对话和画布，需接入画布 node 创建、sourceNodeId/edge 语义和 asset blob 处理。
- 需要安全兜底：LLM 增强失败时应保留原始 prompt 直接生成；参数自动决策失败时应落回 MivoCanvas 现有默认模型/比例/分辨率。

## 结论

状态：**找到 prompt 增强 agent，但只是部分形态**。

- `ro-story-studio` 是真实、最接近目标的 prompt enhancement before image generation：中文短剧情 -> LLM 动作/表情润色 -> Mivo Hub 生图。
- `shared/api-server` + `flux-svg` 是真实、可复用的英文翻译+轻增强 before generation：中文 prompt -> 英文短 prompt -> ComfyUI 生图。
- 线上 Mivo 所需的“深度思考/场景识别/自动模型尺寸/丰富英文 prompt/画布回流”在 toolbox 中没有完整实现；应把现有逻辑视作原型素材和提示词参考，而不是可直接搬运的完整 agent。
