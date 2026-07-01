# M0 生成接入步骤计划

## PHASE_GOAL
在 `vite.config.ts` 的现有 dev middleware 中接入两个同源端点：`POST /api/mivo/generate` 和 `POST /api/mivo/edit`。前端只访问 `/api/mivo/*`；`MIVO_IMAGE_API_KEY` 由 `defineConfig(({mode}) => loadEnv(...))` 在 Node config 阶段读取并注入中间件闭包，禁止 `VITE_` 前缀，返回值固定为 master 契约的 `{images:[{b64}]}`。

## 精确改动清单
| 文件 / 符号 | 改动 |
|---|---|
| `vite.config.ts:1-5` imports | 把第一行改为 `import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'`；继续使用现有 `fs/path/os` import。新增 helper 不引入前端可见 env，也不新增 `VITE_` 变量。若 TypeScript 需要 `Buffer` 类型，使用 Node 全局或补 `import { Buffer } from 'node:buffer'`。 |
| `vite.config.ts:7-8` 常量区 | 在 `eagleApiBase` 后新增 `mivoImageApiBase = 'https://llm-proxy.tapsvc.com/v1/images'`、`defaultMivoImageModel = 'gpt-image-2'`、`mivoQualitySet = new Set(['low','medium','high'])`。 |
| `vite.config.ts:7-8` 常量区 | 新增 `mivoImageSizeMap`，按 `docs/demo/reuse-inventory.md` 的表写死：`1:1/3:2/2:3/16:9/9:16` × `low/medium/high`，未知比例回落 `1:1`，未知质量回落 `medium`。 |
| `vite.config.ts:86-102` `requestJson` 附近 | 新增 `readImageApiKey(imageApiKey)`：只读传入闭包的 `imageApiKey.trim()`；为空时抛 `MIVO_IMAGE_API_KEY is not set`。禁止读取 `import.meta.env`，禁止导出给前端。 |
| `vite.config.ts:86-102` `requestJson` 附近 | 新增 `sendMivoJson(response,status,payload)`，统一设置 `Content-Type: application/json; charset=utf-8`，错误返回 `{error:string}`。 |
| `vite.config.ts:86-102` `requestJson` 附近 | 新增 `readRequestBuffer(request, maxBytes)` 与 `readJsonRequest<T>(request)`；JSON body 只解析 `prompt/imgRatio/quality/n/model`，`prompt` 使用 `String(value || '').trim()`。 |
| `vite.config.ts:86-102` `requestJson` 附近 | 新增 `parseMultipartRequest(request)`：从 `content-type` 取 `boundary`，解析 text fields 与 file fields；保留 `image`、`mask`、`reference[]` 字段名，兼容读取旧字段名 `reference`，并保留文件名、MIME、Buffer。单请求上限先设 `40 * 1024 * 1024`，超限返回 413。 |
| `vite.config.ts:86-102` `requestJson` 附近 | 新增 `imageSizeFor(imgRatio, quality)`，返回 `mivoImageSizeMap[ratio][quality]`；该函数是唯一 size 映射入口。 |
| `vite.config.ts:86-102` `requestJson` 附近 | 新增 `normalizeMivoImages(payload)`：读取 llm-proxy 的 `payload.data[].b64_json` 或兼容 `payload.images[].b64`，输出 `{images:[{b64}]}`；空结果抛 `Image API returned no images`。 |
| `vite.config.ts:86-102` `requestJson` 附近 | 新增 `proxyMivoGenerate(request,response,imageApiKey)`：校验 `POST`，读取 JSON，组装 `{model,prompt,n,size,quality}`，用 `Authorization: Bearer ${readImageApiKey(imageApiKey)}` 转发 `POST ${mivoImageApiBase}/generations`。 |
| `vite.config.ts:86-102` `requestJson` 附近 | 新增 `proxyMivoEdit(request,response,imageApiKey)`：校验 `POST` 和 multipart，要求 `image` 文件存在；把 `image`、可选 `mask`、`model/prompt/size/quality` append 到新的 `FormData`；额外 reference 只作为 best-effort，接收 `reference[]` 并兼容 `reference`，若 llm-proxy 拒绝多图则第一轮回退为不发送额外 reference。`mask` 始终是独立 part，不和 `reference[]` 混用。 |
| `vite.config.ts:221` `localAssetLibraryPlugin` | 把 `localAssetLibraryPlugin = (): Plugin => ({...})` 改为 `localAssetLibraryPlugin = ({ imageApiKey }: { imageApiKey: string }): Plugin => ({...})`，让 key 只存在 Node plugin 闭包中。 |
| `vite.config.ts:221-226` `localAssetLibraryPlugin.configureServer` middleware 入口 | 用 `const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')` 和 `const pathname = requestUrl.pathname` 取路径；在 `/api/mivo/local-assets` 之前插入两个路由：`if (pathname === '/api/mivo/generate') return proxyMivoGenerate(request,response,imageApiKey)`；`if (pathname === '/api/mivo/edit') return proxyMivoEdit(request,response,imageApiKey)`。不要用 `url === ...`，避免 query/cache-buster 掉到 `next()`。 |
| `vite.config.ts:227-387` 现有 local/Eagle routes | 不改现有 `/api/mivo/local-assets`、`/api/mivo/eagle/*`、`/api/mivo/pinterest/status` 行为；M0 新路由必须在同一个 plugin 内并与这些 path 精确区分。 |
| `vite.config.ts:394-397` `defineConfig` | 改为 `export default defineConfig(({ mode }) => { const env = loadEnv(mode, process.cwd(), ''); const imageApiKey = env.MIVO_IMAGE_API_KEY || process.env.MIVO_IMAGE_API_KEY || ''; return { plugins: [react(), localAssetLibraryPlugin({ imageApiKey })] } })`。不要把 `imageApiKey` 写进 `define`、`import.meta.env`、client 常量或响应 body。 |
| `.gitignore:29-31` env ignore | 不改文件；现有 `.env` 和 `.env.*` 已覆盖 `.env.local`。执行 M0 时只在本机创建 `.env.local`，内容为 `MIVO_IMAGE_API_KEY=...`，不提交；禁止 `VITE_MIVO_IMAGE_API_KEY`。 |

## 依赖与落地顺序
1. 在本机 `.env.local` 放 `MIVO_IMAGE_API_KEY`；`vite.config.ts` 通过 `loadEnv(mode, process.cwd(), '')` 读取并传入 `localAssetLibraryPlugin({ imageApiKey })`。不依赖裸 `process.env` 自动加载 `.env.local`，不使用 `VITE_MIVO_IMAGE_API_KEY`。
2. 写 `imageSizeFor` 与 `normalizeMivoImages`，先用纯对象输入在代码中可读地覆盖 5 个比例和 3 个质量。
3. 写 `readJsonRequest` 和 `proxyMivoGenerate`，先跑通 JSON 文生图。
4. 写 `readRequestBuffer`、`parseMultipartRequest` 和 `proxyMivoEdit`，再接 image/mask multipart。
5. 把两个 route 接到 `localAssetLibraryPlugin.configureServer` 的 middleware 入口，使用 `requestUrl.pathname` 精确匹配 `/api/mivo/generate` / `/api/mivo/edit`。
6. 用 curl 验证 M0-SC1/M0-SC2；确认浏览器 Network 只出现 `/api/mivo/*`，再做 M0-SC3 的 bundle/key 检查。

## SC 验收
| master SC | 浏览器 / 命令怎么验 | 看到什么算通过 |
|---|---|---|
| M0-SC1 `/api/mivo/generate` 返回真实 b64 PNG | dev server 启动后执行：`curl -s http://localhost:5173/api/mivo/generate -H 'content-type: application/json' --data '{"prompt":"a small red cube on a white table","imgRatio":"1:1","quality":"low","n":1}' \| jq -r '.images[0].b64' \| head -c 40` | 输出不是 `null`，是长度大于 1000 的 base64；把完整 `.images[0].b64` 解码后文件头是 PNG 或 JPEG。 |
| M0-SC2 `/api/mivo/edit` 传 image+mask 返回真实编辑图 | 准备 `source.png` 和同尺寸 `mask.png`，执行：`curl -s http://localhost:5173/api/mivo/edit -F image=@source.png -F mask=@mask.png -F prompt='replace the marked area with a blue glass sphere' -F imgRatio=1:1 -F quality=low \| jq -r '.images[0].b64' \| head -c 40` | 输出是 base64；解码后是有效图片；缺少 `image` 时返回 400 `{error:"image is required"}`。 |
| M0-SC3 key 不进 bundle / Network | 浏览器触发一次生成，DevTools Network 选中 `/api/mivo/generate`，检查 Request Headers；执行阶段再跑 `npm run build` 后 `rg 'MIVO_IMAGE_API_KEY|Bearer|llm-proxy|实际key前8位' dist`。 | Network 请求没有 `Authorization` header；`dist` 中没有实际 key 字符串、`MIVO_IMAGE_API_KEY`、`Bearer` 或 `llm-proxy`。`llm-proxy` 只存在于 `vite.config.ts` 的 dev server 代码，不进入前端产物。 |

## 风险与回退
| 风险 | 处理 / 回退 |
|---|---|
| `.env.local` 未加载，端点返回 500 | 检查 `defineConfig(({mode}) => loadEnv(mode, process.cwd(), ''))` 是否执行，并确认 `localAssetLibraryPlugin({ imageApiKey })` 收到非空值；`readImageApiKey(imageApiKey)` 返回 `{error:"MIVO_IMAGE_API_KEY is not set"}` 时只补 env 并重启 dev server，不碰前端。 |
| multipart parser 对二进制边界处理出错 | 保留 `parseMultipartRequest` 为单独 helper；回退时只移除 `/api/mivo/edit` route 和 helper，`/api/mivo/generate` 可继续工作。 |
| llm-proxy 返回非 OpenAI 标准结构 | `normalizeMivoImages` 同时兼容 `data[].b64_json` 与 `images[].b64`；仍为空时把上游状态码和 message 返回给前端。 |
| 文件过大导致 dev server 内存压力 | `readRequestBuffer` 固定 40MB 上限；返回 413，不进入上游请求。 |
| 误把 key 放进前端 | 搜索 `VITE_MIVO_IMAGE_API_KEY`、`import.meta.env.MIVO_IMAGE_API_KEY`、`define:.*MIVO_IMAGE_API_KEY`、`Authorization`；发现则回退相关前端改动，key 只保留在 `vite.config.ts` Node middleware 闭包。 |
