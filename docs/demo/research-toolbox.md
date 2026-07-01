# XD-AIGC-toolbox 可复用补充调研

目标仓：`/Users/praise/AI-Agent/Claude/reference/projects/XD-AIGC-toolbox`（只读检查）。本文件只补 MivoCanvas demo 还缺的 UI / multipart / 素材库 / 参考图交互线索。

## M2 mask / 区域交互 UI

模块 → 可复用(`file:line` + 用法) / 需重写(原因)

- M2 框选锚点 → 可复用 `tools/xd-town-hair-generator/public/lib-bbox-editor.js:1-5`、`tools/xd-town-hair-generator/public/lib-bbox-editor.js:11-24`、`tools/xd-town-hair-generator/public/lib-bbox-editor.js:26-47`、`tools/xd-town-hair-generator/public/lib-bbox-editor.js:49-67`、`tools/xd-town-hair-generator/public/lib-bbox-editor.js:69-85`、`tools/xd-town-hair-generator/public/lib-bbox-editor.js:99-127`。这是单框 `SingleBBoxEditor(container, imgSrc, initialBox)`，坐标落在图片原始像素空间，适合 MivoCanvas 对单张图做“框选局部重绘区域”。接入样例见 `tools/xd-town-hair-generator/public/app-item-detail.js:63-99`，样式见 `tools/xd-town-hair-generator/public/styles.css:443-454`。/ 需重写：把回调结果从“重切 bbox”改成 MivoCanvas 的 anchor selection，并把 bbox 转成 mask PNG。
- M2 多框锚点 → 可复用 `tools/xd-fashion-trend-studio/public/lib-bbox-editor.js:1-5`、`tools/xd-fashion-trend-studio/public/lib-bbox-editor.js:11-24`、`tools/xd-fashion-trend-studio/public/lib-bbox-editor.js:56-99`、`tools/xd-fashion-trend-studio/public/lib-bbox-editor.js:108-119`、`tools/xd-fashion-trend-studio/public/lib-bbox-editor.js:121-174`、`tools/xd-fashion-trend-studio/public/lib-bbox-editor.js:181-198`。这是多框 `BBoxEditor`，支持创建、选中、移动、缩放、删除，适合后续多区域编辑。样式见 `tools/xd-fashion-trend-studio/public/styles.css:258-296`。/ 需重写：它只产 bbox 数组，不产图像 mask；要在 MivoCanvas 中按 bbox 填充透明编辑区或不透明保留区。
- M2 涂抹 / 画笔 mask → 可复用 `tools/pixel-forge/index.html:512-543` 的工具栏形态、`tools/pixel-forge/index.html:699-716` 的 canvas 状态、`tools/pixel-forge/index.html:777-789` 的 stamp/eraser 写像素、`tools/pixel-forge/index.html:858-901` 的 pointer 绘制主循环、`tools/pixel-forge/index.html:915-926` 的 hover brush 预览、`tools/pixel-forge/index.html:928-940` 的线/矩形/圆形工具、`tools/pixel-forge/index.html:1356-1375` 的 PNG 导出思路。/ 需重写：这是像素画编辑器，不是“在原图上叠 mask”的 inpaint UI；需要改为源图自然尺寸的透明 mask canvas，并按 gpt-image-2 约定输出 PNG（透明区域 = 要改）。
- M2 canvas/image 转 PNG Blob → 可复用 `tools/tap-avatar-frame/index.html:2435-2443` 的 `pvImgToBlob(img)`。/ 需重写：对 mask 应直接 `maskCanvas.toBlob(..., 'image/png')`，不要导出显示层截图，避免把源图混入 mask。

## M2 `/v1/images/edits` mask multipart 构造

模块 → 可复用(`file:line` + 用法) / 需重写(原因)

- M2 edits multipart 基础拼法 → 可复用 `tools/tap-avatar-frame/server.js:92-158`：手写 boundary，把 `image` / 多图 `image[]`、`model`、`prompt`、`n`、`size`、`quality` 拼成 multipart，再 `POST ${OPENAI_BASE}/v1/images/edits`。/ 需重写：全仓未发现真正传 `mask` 字段；该函数只传 image/reference images。结论：`/v1/images/edits` 的 mask multipart 构造：无,需自建。
- M2 mask 字段落点 → 可复用上面 `parts.push(...)` 的文件 part 写法。新增时应在 source image 后、普通字段前加入 `Content-Disposition: form-data; name="mask"; filename="mask.png"` + `Content-Type: image/png` + mask buffer。/ 需重写：`tools/tap-avatar-frame/server.js:102-115` 当前只按 `image`/`image[]` 写图片，且 `tools/tap-avatar-frame/server.js:139-147` 的日志和请求也只知道 image 数量。
- M2 前端到 Node 的 multipart 解析 → 可复用 `tools/tap-avatar-frame/server.js:649-701` 的 `parseMultipart(req)`，它已经保留 `allFiles` 里的字段名和临时路径。/ 需重写：`/api/repaint` 目前在 `tools/tap-avatar-frame/server.js:856-884` 直接把所有文件当图1/图2参考图，MivoCanvas 需要显式区分 `image`、`mask`、`reference[]`，不能把 mask 塞进参考图列表。

## M4 Eagle / 本地素材库搜索 UI

模块 → 可复用(`file:line` + 用法) / 需重写(原因)

- M4 Eagle 搜索/网格/上传面板 → 可复用 `tools/ro-story-studio/public/index.html:1156-1174` 的侧栏 tabs + 搜索框 + grid + 上传入口，`tools/ro-story-studio/public/index.html:2178-2186` 的 selected/temp state，`tools/ro-story-studio/public/index.html:2314-2410` 的搜索过滤、grid 构建、上传卡、素材卡，`tools/ro-story-studio/public/index.html:2549-2592` 的上传入临时素材，`tools/ro-story-studio/public/index.html:2793-2825` 的拖拽上传和粘贴图片。/ 需重写：没有 Eagle 专用 API；需要把数据源替换成 Eagle local API / dev middleware，并给素材卡补 `draggable` + `dragstart` 数据。
- M4 远程素材库代理模式 → 可复用 ArtDAM 路线：配置和缓存根见 `tools/xd-town-studio/server.js:146-156`，素材 ref/缩略图 URL 拼法见 `tools/xd-town-studio/server.js:302-314`，按目录拉取图片资产见 `tools/xd-town-studio/server.js:350-358`，列表/缩略图/文件代理路由见 `tools/xd-town-studio/server.js:1205-1240`。前端 grid 可抄 `tools/xd-town-studio/public/index.html:807-815`、角色卡/网格 `tools/xd-town-studio/public/index.html:1258-1312`、场景卡 `tools/xd-town-studio/public/index.html:1358-1374`、启动加载 `tools/xd-town-studio/public/index.html:2044-2112`。/ 需重写：ArtDAM 是发布空间 + token + thumbnail proxy，不是 Eagle；只借“服务端代理本地/远端资产、前端卡片消费统一 URL”的结构。
- M4 本地相册式素材库 → 可借鉴 Immich：前端状态/相册/资产导入见 `tools/batch-img-gen/index.html:622-695`，后端状态/相册/资产/导入路由见 `shared/api-server/routes/batch_img_gen.py:107-157`。/ 需重写：该 UI 只有相册选择和批量导入，没有关键字搜索、缩略图真实预览不足，也没有拖进画布。
- M4 拖进画布 → 需重写：全仓搜索未发现可复用的素材卡 `dragstart` / `dataTransfer.setData`；只发现上传 drop 逻辑，例如 `tools/ro-story-studio/public/index.html:2793-2825`。MivoCanvas 的 Eagle 卡片拖入 LeaferJS 画布需要新写。

## M1 图生图 / 参考图上传交互与请求拼装

模块 → 可复用(`file:line` + 用法) / 需重写(原因)

- M1 主对话框图生图上传 → 可复用 `tools/tap-avatar-frame/index.html:1850-1870` 的文件校验、FileReader 预览、状态写入，`tools/tap-avatar-frame/index.html:1882-1898` 的拖拽上传，`tools/tap-avatar-frame/index.html:1920-1953` 的“有上传走 edit / 无上传走 generate”分支，`tools/tap-avatar-frame/index.html:1999-2015` 的 `FormData(file, instruction, resolution)` 请求。/ 需重写：MivoCanvas 要把结果落到画布节点和派生链，不是聊天消息卡片。
- M2 参考图 / 重绘面板 → 可复用 `tools/tap-avatar-frame/index.html:1498-1573` 的右侧 repaint panel 结构，`tools/tap-avatar-frame/index.html:2844-2884` 的源图状态与 URL/blob 转换，`tools/tap-avatar-frame/index.html:2905-2948` 的多参考图缩略卡，`tools/tap-avatar-frame/index.html:2950-2991` 的源图/参考图拖拽，`tools/tap-avatar-frame/index.html:2993-3018` 的粘贴图片，`tools/tap-avatar-frame/index.html:3036-3075` 的 source-first + refs 后续 append 请求。/ 需重写：它是多图参考重绘，不包含 mask；MivoCanvas 要把当前 canvas image、mask PNG、可选 refs 分字段提交。
- M1/M2 后端上传入口 → 可复用 `tools/tap-avatar-frame/server.js:828-851` 的单图 edit endpoint、`tools/tap-avatar-frame/server.js:854-888` 的 source-first repaint endpoint、`tools/tap-avatar-frame/server.js:189-240` 的 b64 保存与 job 状态更新。/ 需重写：demo 目标是同步 llm-proxy，没必要照搬异步轮询全部状态机；但 b64 落盘/转 data URL/错误处理模式可借鉴。
- M1 固定参考图槽位 → 可复用 `tools/batch-img-gen/index.html:498-555` 的 13 个 ref slot 管理。/ 需重写：MivoCanvas 主对话框更适合轻量附件条，除非要固定多参考槽。
- M1 多参考图 prompt 顺序 → 可借鉴 `tools/ro-story-studio/server.js:850-880` 和 `tools/ro-story-studio/server.js:897-935`：按图1角色、后续道具/场景图构造 prompt 和 images 数组。/ 需重写：该路径走 mivoserver 队列，不是 llm-proxy；只能借“图像顺序和 prompt 标签”。

## 其他对 M1 / M2 / M4 有用的可复用件

模块 → 可复用(`file:line` + 用法) / 需重写(原因)

- M1/M2 b64 结果保存 → 可复用 `tools/tap-avatar-frame/server.js:189-240`：同步/异步调用后把 `data[].b64_json` 写成 PNG 并返回 URL。/ 需重写：Vite dev middleware 可以直接返回 data URL 或对象 URL；落盘仅用于调试/历史。
- M4 临时素材上传 → 可复用 `tools/ro-story-studio/server.js:704-750` 的 `/api/temp-assets` multipart 校验、保存、返回 `refImage/coverImage`，以及 `tools/ro-story-studio/server.js:1065-1082` 的删除/静态读取。/ 需重写：Eagle 素材通常不应复制进 temp；应优先引用本地资产 URL/缩略图代理，只在用户上传临时素材时复用。
- M1/M2 图片上传 multipart parser → 可复用 `tools/tap-avatar-frame/server.js:649-701`。/ 需重写：生产代码最好换稳定 multipart parser；demo 可沿用手写版本以减少依赖。

## 净结论

toolbox 对本 demo 最值得抄的 3 段代码：

1. `tools/tap-avatar-frame/index.html:2844-3075`：源图 + 多参考图上传、拖拽、粘贴、预览、FormData 拼装，是 M1 图生图和 M2 重绘面板最快的交互底座。
2. `tools/tap-avatar-frame/server.js:92-158`：`/v1/images/edits` multipart 手写 boundary 调用底座；但全仓无 `mask` 字段，M2 必须在这里自建 `mask` part。
3. `tools/ro-story-studio/public/index.html:1156-1174` + `tools/ro-story-studio/public/index.html:2314-2410` + `tools/ro-story-studio/public/index.html:2793-2825`：最接近 Eagle 的素材搜索/网格/上传面板；Eagle API 和素材卡拖入 LeaferJS 需要新写。
