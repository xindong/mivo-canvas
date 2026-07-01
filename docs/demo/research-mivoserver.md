# mivo-server 增量复用点（MivoCanvas demo）

范围：只看 `/Users/praise/AI-Agent/Claude/reference/projects/mivo-server` 的 gpt-image / NANOBANANA 相关实现。结论按 demo 已知边界收敛：本 demo 不接 mivo-server 后端，M0/M1/M2 直连 `llm-proxy.tapsvc.com` 的 OpenAI-compatible 同步接口。

## 该抄的（file:line + 用法）

### 1. gpt-image-2 的 `imgRatio` / `quality` -> `size` 映射

来源：`api/src/ai_api/tasks/gptimage.py:33-59` 定义 `IMAGE_2_RATIO_MAPPING`，`api/src/ai_api/tasks/gptimage.py:62-69` 解析 `model_str == "gpt-image-2"` 时才启用该表。

M1/M2 直连 `llm-proxy` 时应把前端比例和质量先映射成 OpenAI `size` 参数：

| imgRatio | low | medium | high |
|---|---:|---:|---:|
| `1:1` | `1024x1024` | `2048x2048` | `2880x2880` |
| `3:2` | `1536x1024` | `3072x2048` | `3504x2336` |
| `2:3` | `1024x1536` | `2048x3072` | `2336x3504` |
| `16:9` | `1824x1024` | `2048x1152` | `3840x2160` |
| `9:16` | `1024x1824` | `1152x2048` | `2160x3840` |

默认策略也值得照抄：未知比例回落 `1:1`，`quality` 只接受 `low|medium|high` 参与映射，否则 size 按 `low` 回落（`api/src/ai_api/tasks/gptimage.py:67-69`）。但请求里没传 `quality` 或传 `auto` 时，mivo-server 取 `medium` 算 size，同时不把 quality 透传给 SDK（`api/src/ai_api/tasks/gptimage.py:72-81`）。demo 可更简单：UI 限定 `low|medium|high`，默认 `medium`，并显式传 `quality`。

### 2. gpt-image edits + mask 的拼法

来源链路：
- `api/src/ai_api/v1/facade/gptimage.py:177-181`：默认 `output_format="png"`、`background="auto"`；如果 `background=="transparent"` 则保持 PNG。
- `api/src/ai_api/v1/facade/gptimage.py:237-255`：有 `images` 就走编辑；mivo-server wrapper 字段叫 `maskBase64`。
- `api/src/ai_api/tasks/gptimage.py:314-321`：`mask_base64` 被解码成 `mask.png`，`content_type="image/png"`。
- `api/src/ai_api/tasks/gptimage.py:350-362`：编辑时把 `images`、`mask`、`model`、`prompt`、`n`、`size`、credential 等传给 OpenAI 工具层。
- `common/src/ai_common/clients/openai.py:474-490`：最终调用 `client.images.edit(image=..., prompt=..., mask=mask or omit, model=..., n=..., output_format="png", quality=..., size=..., extra_body={"moderation":"low"}, timeout=600)`。

demo 的直连中间件不用抄 `maskBase64` wrapper；对 `/v1/images/edits` 直接发 `multipart/form-data`：

```text
image=<原图 PNG/JPEG file/blob>
mask=<PNG RGBA file/blob，可选；局部重绘时传>
model=gpt-image-2
prompt=<用户 prompt>
n=1
size=<上表映射出的 size>
quality=<low|medium|high>
output_format=png
background=auto
```

mask 语义：沿用 OpenAI/gpt-image edits 约定，透明像素是要改的区域，不透明像素是保留区域。mivo-server 的 mask helper 也是把白色区域转成 alpha=0、其他区域 alpha=255（`common/src/ai_common/tools/openai.py:295-343`），即「透明=编辑区域」。

mask 尺寸约束不要照抄旧文档的“必须正方形”。mivo-server 旧说明写了编辑图必须正方形、mask 必须 32-bit RGBA PNG（`docs/models_desc.md:35-39`），工具层 docstring 也写了 mask 必须正方形（`common/src/ai_common/tools/openai.py:379-385`），但当前运行代码没有做正方形校验；反而 `create_transparent_mask` 按原图宽高建同尺寸透明 mask（`common/src/ai_common/tools/openai.py:286-292`），gpt-image-2 又明确支持 `16:9` / `9:16` 等非方形输出（`api/src/ai_api/tasks/gptimage.py:49-58`）。demo M2 应生成“与送入 edits 的原图同像素尺寸”的 PNG RGBA mask；不额外强制正方形。

### 3. gemini-3-pro-image / NANOBANANA 备选路线

只作为 `llm-proxy` 不支持 Gemini 时的参考，不建议今晚接入。

调用形状来自 `api/src/ai_api/v1/facade/nano.py`：
- 模型类型是 `NANOBANANA`，版本通过 `modelFormat.version` 解析；默认/最新是 `gemini-3-pro-image`（`common/src/ai_common/tools/nano.py:44-97`）。
- prompt 会被包装为 `"**img** " + raw_prompt`（`api/src/ai_api/v1/facade/nano.py:233-239`）。
- 参考图来自 payload `images`（`api/src/ai_api/v1/facade/nano.py:236-241`）。
- `imgRatio` 会映射成 GenAI `aspect_ratio`，只接受表内比例（`api/src/ai_api/v1/facade/nano.py:31-42`、`api/src/ai_api/v1/facade/nano.py:247-250`）。
- `resolution` 从 payload 或旧 payload 取（`api/src/ai_api/v1/facade/nano.py:252-256`）。
- provider 从 payload 或 `nanobanana.provider` 配置取，允许 `genai|minimax|baidu`（`api/src/ai_api/v1/facade/nano.py:258-267`）。
- 实际异步任务投到 `queue="image"`、`model_type=ModelType.NANOBANANA`（`api/src/ai_api/v1/facade/nano.py:280-289`）。

GenAI 实际调用在 worker：
- `NanoBananaGeneration.generate_images` 用 Google GenAI SDK `models.generate_content`，`contents` 包含 prompt + image URLs，`config.image_config = ImageConfig(aspect_ratio=..., image_size=...)`（`common/src/ai_common/tools/nano.py:464-475`）。
- 参考图会被规范成 data URI / HTTP URL / FileMeta 签名 URL，必要时转 GCS（`worker/src/ai_worker/models/image/nanobanana.py:151-217`）。
- platform 下 `provider=genai` 遇到 429 才 fallback 到 `baidu`；personal credential 不 fallback（`worker/src/ai_worker/models/image/nanobanana.py:454-460`、`worker/src/ai_worker/models/image/nanobanana.py:543-548`）。
- MiniMax 的 Gemini 3 Pro API model 是 `g3-pro-image-preview`（`api/src/ai_api/v1/facade/nano.py:212-219`、`worker/src/ai_worker/models/image/nanobanana.py:55-61`）。

成本判断：走 mivo-server 的 NANOBANANA 不是一个薄 HTTP 代理，而是 API facade + taskiq worker + OSS/GCS 文件落地 + provider fallback + credential/concurrency 配置。计费也单独：GenAI `gemini-3-pro-image-preview` 约 `$122/1M tokens`，MiniMax 对应约 `$73.2/1M tokens`（`docs/model_version_price_mapping.csv:2-7`）。如果 demo 要展示 Gemini，只在 `llm-proxy` 已支持 OpenAI-compatible 同步调用时接；否则今晚不接。

### 4. 少量可复用的小习惯

- prompt 入参只做轻量清洗：mivo-server 会 `strip(".")`，避免 prompt 末尾多余英文句点影响模板拼接（`api/src/ai_api/v1/facade/gptimage.py:173-176`）。demo 可以只做 `trim()`，不必上 SmartPrompt。
- 默认输出 PNG：gpt-image handler 默认 `output_format="png"`，透明背景时强制 PNG（`api/src/ai_api/v1/facade/gptimage.py:177-181`）。demo 的生成/编辑统一按 PNG b64 回填画布。
- GPT quality 白名单：CLI 只接受 `low|medium|high|auto`（`mivo-cli/src/commands/image.rs:332-343`）。demo UI/中间件应限制到 `low|medium|high`，避免把未知值传到 llm-proxy。

## 明确跳过的

- 不接 mivo-server 的任务/消息/投影体系：创建 Task、异步后台执行、OSS 保存、结果投影都服务于完整产品消息流（`api/src/ai_api/tasks/gptimage.py:92-132`、`api/src/ai_api/tasks/gptimage.py:394-535`、`api/src/ai_api/v1/facade/gptimage.py:281-322`）。demo 是同步 b64 回填画布，不需要。
- 不抄 credentialSource / personal tapsvc 管理：mivo-server 会按 `credentialSource` 切 platform / personal，并解析个人 tapsvc key（`api/src/ai_api/v1/facade/gptimage.py:195-205`、`common/src/ai_common/tools/openai.py:87-120`）。demo 只在 Vite middleware Node 侧读本地 key。
- 不抄 `openai.image2` 平台配置分流：mivo-server platform 下 `gpt-image-2` 走 `openai.image2` 配置，personal 才走 tapsvc（`common/src/ai_common/tools/openai.py:94-120`、`common/tests/clients/test_openai.py:349-476`）。demo 已定为直连 `https://llm-proxy.tapsvc.com/v1`，只需保留 base URL + key。
- 不抄 `provider=baidu` 的 GPT Image 分支：它只支持 `gpt-image-2` 且不支持 personal credential（`api/src/ai_api/tasks/gptimage.py:218-230`、`api/src/ai_api/tasks/gptimage.py:330-343`）。demo 默认 OpenAI-compatible。
- 不抄 prompt 翻译/润色/SmartPrompt：`translate_prompt` / `polish_prompt` 是额外 chat 调用（`common/src/ai_common/tools/openai.py:29-75`），会增加延迟和变量；demo 直接用用户 prompt。
- 不抄 HMAC 防重复提交：`sign_params` 依赖 Redis（`api/src/ai_api/v1/facade/gptimage.py:58-112`），demo 本地同步调用不需要。
- 不抄 NANOBANANA 的 `**img**` prompt 包装到 GPT Image：这是 Gemini/Nano facade 的输入格式（`api/src/ai_api/v1/facade/nano.py:233-239`），不属于 gpt-image-2。

净结论：demo 不需要碰 mivo-server；只抄 `gpt-image-2` 的比例/质量到 `size` 映射和 edits 的 PNG RGBA 同尺寸 mask 拼法，其余 mivo-server 后端任务、凭证、OSS、NANOBANANA 路线都跳过。
