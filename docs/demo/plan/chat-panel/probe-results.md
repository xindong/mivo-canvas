# P0 探针结果（llm-proxy.tapsvc.com）

> 实测：2026-07-02 | key = `MIVO_IMAGE_API_KEY`（secrets/image-key.raw）| 全部真实请求，非文档推断

## 能力矩阵（modelCapabilities.availability 依据）

| 模型 | 端点 | 状态 | 实测 |
|---|---|---|---|
| `moonshotai/kimi-k2.6`（enhance 主力） | `/v1/chat/completions` | ✅ ok | **不带 response_format 3.5s**、带 json_object 5.1s；两种都出合法 JSON |
| `qwen/qwen3.6-plus`（enhance 降级） | `/v1/chat/completions` | ✅ ok（有条件） | **不带 response_format 14.3s 合法 JSON；带 json_object 挂死 30s+ 超时 → 禁用 rf** |
| `gpt-image-2` | `/v1/images/generations|edits` | ✅ ok | 现有 M0 链路已验证；比例走 `size` 字符串（mivoImageSizeMap 5 档） |
| `gemini-3-pro-image` | `/v1/images/generations` | ✅ ok | 25s 出图；**比例走 `aspect_ratio` 参数**（`"21:9"` → 1408×768 实测生效）；`size:"21:9"` 被忽略回落 1024² |
| `doubao-seedance-2-0-260128` | — | ❌ unavailable | 模型在 `/v1/models` 清单，但**无可调用端点** |
| `doubao-seedance-2-0-fast-260128` | — | ❌ unavailable | 同上 |

## 关键实现结论

1. **enhance 不用 response_format**：kimi 不带 rf 更快（3.5s vs 5.1s）且 qwen 带 rf 会挂死。统一 prompt 强制 JSON + 服务端容错解析（strip markdown fence → parse）。
2. **enhance 降级链**：kimi(10s 超时) → qwen(15s 超时) → 原文直出 enhanced:false。实测 kimi 3.5s 满足 <8s 目标。
3. **比例参数按模型分流**（vite 代理层）：gpt-image-2 → `size`（现有 map）；gemini-3-pro-image → `aspect_ratio` 直传比例字符串（无需 size map 扩表）。
4. **视频链路挂起**：已探 8 种路径全 404/400（`/v1/video/generations`、`/v1/videos(/generations)`、`/v1/contents/generations/tasks`、`/api/v3/...`、`/ark/...`、`/v3/...`、chat/responses/images 包装）。seedance 模型注册了但网关未暴露视频端点。**Composer 中 Video 分类置灰 + 原因提示；需要网关方提供视频端点文档后再启 V 阶段**。
5. chat 延迟参考：gpt-5.4-mini 0.3s（可作 e2e/调试用）；gemini 生图 25s、gpt-image-2 生图历史实测 30-60s —— 对话面板的"generating"态要按分钟级预期设计。

## 探过的视频路径（全部不通，别再试）

POST `/v1/video/generations`、`/v1/videos/generations`、`/v1/videos`、`/v1/video/generation`、`/v1/contents/generations/tasks`、`/v3/contents/generations/tasks`、`/api/v3/contents/generations/tasks`、`/ark/api/v3/contents/generations/tasks` → 404；seedance 走 chat/responses/images 端点 → 400 Invalid model（网关按端点路由模型）。`ai-gateway-doc` 伪模型不可对话，`/openapi.json` 404。
