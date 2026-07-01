# MivoCanvas Demo · 居中底部通用工具条调研

> 范围：只看本地三仓 `mivo-server` / `XD-AIGC-toolbox` / `open-design`。本 demo 仍按 `master-plan`：直连 `llm-proxy` 的 `gpt-image-2` 同步生成/编辑，不接 `mivo-server` 后端。

## ① 典型工具集

loveart 式画布底部工具条通常不是“所有后端能力入口”，而是围绕当前选中图片的轻量操作带：

- 基础模式：选择/移动、生成、参考图生成/图生图。
- 局部编辑：局部重绘/遮罩编辑（框选、画笔、点选）、撤销、重做、提交。
- 图片处理：抠图/去背景、超分/高清放大、扩图/Outpaint、擦除/清理、变体/重新生成。
- 多媒体/资产：视频/图生视频、素材/参考图添加、下载/导出。

对本 demo，工具条不应一次铺满这些能力。M6 最小闭环只需要把 M1/M2 入口放出来；抠图、超分、扩图、视频都属于后续后端能力。

## ② 每工具功能代码位置 + 直连可行性

| 工具 | 本地现成代码位置 | 能否直连 `llm-proxy` | Demo 判断 |
|---|---|---|---|
| 生成（文生图） | MS `api/src/ai_api/v1/facade/gptimage.py:213-235`：无 `images` 时创建生成任务；MS `api/src/ai_api/tasks/gptimage.py:33-69`：`gpt-image-2` 的 `imgRatio/quality -> size`；MS `api/src/ai_api/tasks/gptimage.py:200-246`：解析 `prompt/n/imgRatio/quality/model` 后调用 OpenAI；MS `common/src/ai_common/clients/openai.py:407-452`：`client.images.generate(...)` 参数形状。 | 可以。跳过 MS Task/Message 层，M0 直接把 M1 JSON 转 `/v1/images/generations`。 | 今晚做，工具条按钮“生成”接 M1。 |
| 图生图/参考图生成 | MS `api/src/ai_api/v1/facade/gptimage.py:237-256`：有 `images` 时走编辑任务；MS `common/src/ai_common/clients/openai.py:455-492`：`client.images.edit(image, prompt, mask?, model, n, quality, size...)`；TB `tools/tap-avatar-frame/server.js:92-158`：手写 multipart 调 `/v1/images/edits`，多图用 `image[]`；TB `tools/tap-avatar-frame/index.html:1920-1953`：有上传走 edit、无上传走 generate。 | 可以。M0 `/api/mivo/edit` multipart 透传 `image/reference[]/prompt/size`。 | 属 M1 对话框能力，不建议占一个底栏按钮。 |
| 局部重绘（mask edits） | MS `api/src/ai_api/v1/facade/gptimage.py:237-250`：`maskBase64` 独立于 `images` 传入；MS `api/src/ai_api/tasks/gptimage.py:314-321`：mask 解码为 `mask.png`；MS `api/src/ai_api/tasks/gptimage.py:350-362`：`edit_image(..., mask=mask_img, size=...)`；MS `common/src/ai_common/clients/openai.py:474-490`：SDK edits 调用形状。OD `apps/web/src/components/PreviewDrawOverlay.tsx:33-40`、`:227-235`、`:291-343`、`:985-1074` 可抄框选/画笔/撤销/重做交互。 | 可以。前端自建同尺寸 RGBA mask，M0 `/api/mivo/edit` 传 `image` + `mask` + `prompt`。 | 今晚做，工具条按钮“局部重绘”接 M2。 |
| 变体/重新生成 | TB `tools/tap-avatar-frame/index.html:2768-2782`：结果卡上的“重新生成”只是用旧 prompt 再调 `doGenerate`；TB `tools/tap-avatar-frame/index.html:1956-1986`：重新请求 `api/generate`。MS GPTImage 未看到独立 variation handler。 | 可以作为“再生成一次”的 M1 包装；不是独立后端能力。 | 后续可做成选中图右键/卡片动作，今晚不放最低底栏。 |
| 抠图/去背景 | MS `api/src/ai_api/v1/facade/alicloud.py:249-270`：BRIA `segment` handler；MS `common/src/ai_common/tools/bria.py:7-17`：`remove_background(image_url)`；MS `common/src/ai_common/clients/bria.py:20-40`：调用 Bria `/v2/image/edit/remove_background`；TB `shared/api-server/routes/frame_bg_remover.py:22-113`、`:221-264`：OpenCV 白底去除，`POST /process` 返回透明 PNG；TB `tools/tap-avatar-frame/server.js:530-553`：旧 Mivo ALICLOUD segment 流；`:556-647`：sharp 本地背景色 alpha fallback；`:891-935`：`/api/segment` 先 Mivo 后 fallback。 | 不走 `llm-proxy`。要么接 MS/Bria/OSS，要么引入 TB 的本地/共享后端算法。 | Demo 外。可在底栏显示禁用或更多菜单，不做今晚验收。 |
| 超分/高清放大 | MS `api/src/ai_api/v1/facade/alicloud.py:25-30`：AliCloud handler 只允许 `super_resolution`；MS `api/src/ai_api/v1/facade/alicloud.py:233-246`：签名 URL 后按 `scale` 调超分；MS `api/src/ai_api/tasks/alicloud.py:110-121`：超分 task；MS `common/src/ai_common/tools/alicloud.py:233-274`：`super_resolution(image_url, scale=2)`；MS `common/src/ai_common/clients/alicloud.py:154-220`：AliCloud ImageEnhance 调用。 | 不走 `llm-proxy`，依赖 AliCloud credential/OSS/task。 | Demo 外。 |
| 扩图/Outpaint | MS `common/src/ai_common/clients/bflai.py:11-23` 有 `FluxProV1_1Fill` / `FluxProV1_0Expand` enum；MS `common/src/ai_common/tools/bflai.py:138-212` 有 Flux generate/edit；MS `api/src/ai_api/v1/facade/bflai.py:68-75`、`:122-269` 只有无图生成/有图编辑的通用 facade。未看到稳定 outpaint facade。 | 不建议今晚直连。理论上 gpt-image edits 可用“扩画布+透明 mask”自研，但三仓没有可直接抄的实现。 | Demo 外/后续实验。 |
| 视频/图生视频 | MS `api/src/ai_api/v1/facade/qwen.py:74-89`、`:147-195`：QWen video actions 和 video queue；MS `api/src/ai_api/v1/facade/jimeng.py:378-400`、`ark.py:418-438`、`kling.py:241-262`、`mj.py:170-186`：多个视频 provider 都进 `video` queue/异步任务。 | 不走本 demo `llm-proxy` 同步图片链路。 | Demo 外。 |
| 素材/参考图 | OD `apps/web/src/runtime/design-toolbox.ts:12-28`、`:38-151`：action catalog 里有 `asset-search/image-gen/video-gen` 等；ChatComposer 接入 DesignToolboxPanel 在 `apps/web/src/components/ChatComposer.tsx:2818-2859`、panel 过滤/资源构建在 `:3893-3975`。 | 与生成后端无关；M4 Eagle 是单独模块。 | 不放 M6 最低按钮；后续可放“素材”入口接 M4。 |

## ③ Demo 今晚可做 vs 后续

今晚可做：

- 工具条壳：底部居中 floating bar，避开左侧 sidebar 和右下 M1 首图框。
- `选择/移动`：退出当前工具态，回到普通画布操作。
- `生成`：打开/聚焦 M1 prompt，对空画板走 `/api/mivo/generate`；有参考图仍走 M1 自己的附件槽，不把复杂附件塞进底栏。
- `局部重绘`：要求选中图片节点，进入 M2 mask 模式；展开框选/画笔/撤销/重做/prompt/提交；提交到 `/api/mivo/edit`，结果仍按 M5 生成新节点 + edge。

后续/需要后端或额外模型：

- 抠图/去背景：MS Bria/AliCloud 或 TB frame-bg-remover/sharp 都需要后端服务，不属于 `llm-proxy` 图片生成接口。
- 超分：依赖 AliCloud ImageEnhance。
- 扩图：本地只有 BFL enum 线索，没有可抄的稳定 facade；若用 gpt-image edits 需要自建 padded canvas/mask 流。
- 视频：所有本地实现都是 mivo-server 异步 video queue/provider。
- 变体：可先复用“重新生成/同图再 edit”，但不是独立验收目标。

## ④ 可复用 UI

最值得抄的是 Open Design 的 `PreviewDrawOverlay`：

- OD `apps/web/src/components/PreviewDrawOverlay.tsx:33-40`：工具条事件枚举，已有 `rect/pen/undo/redo/attach_image/submit/exit`。
- OD `apps/web/src/components/PreviewDrawOverlay.tsx:227-235`、`:291-343`：把 pointer 坐标归一化，支持框选和画笔轨迹。
- OD `apps/web/src/components/PreviewDrawOverlay.tsx:761-776`、`:857-860`：工具条 portal/dock 思路，避免被预览容器裁切。
- OD `apps/web/src/components/PreviewDrawOverlay.tsx:960-983`：底部工具条核心样式，`flex-wrap`、半透明背景、blur、圆形工具按钮。
- OD `apps/web/src/components/PreviewDrawOverlay.tsx:985-1118`：关闭、框选、画笔、撤销/重做、附件、prompt、提交按钮组合。
- OD `apps/web/src/components/PreviewDrawOverlay.tsx:1219-1250`、`:1280-1389`：tooltip、子工具组、icon button、bottom dock 样式。MivoCanvas 应把 `left: calc(50% - 52px)` 改成按 sidebar 计算的画布中心。
- OD `apps/web/tests/components/PreviewDrawOverlay.test.tsx:80-112`：已覆盖窄面板里 dock/toolbar wrap 不重叠，可抄测试关注点。

次级可借鉴：

- TB `tools/pixel-forge/index.html:84-126`、`:512-542`：小型 icon toolbar、分隔线、工具按钮 active 态；`:831-901`：工具切换和 pointer 绘制主循环。适合 M2 画笔状态参考，不适合作为底部居中布局。
- TB `tools/frame-bg-remover/index.html:126-198`、`:286-404`：上传、模式 tab、处理/下载按钮、blob 预览/下载流。仅供后续抠图 UI，不放今晚 M6。
- OD `apps/web/src/runtime/design-toolbox.ts:12-28`、`:38-151`：工具命名/分类的 action catalog，可给后续“更多工具”菜单做文案参考；不是底部 bar 布局。

## 明确跳过的

- 不接 MS 的 Message/Task/EventBus/OSS/credential/polling 投影，只抄 GPTImage 参数和 prompt 轻清洗：MS `api/src/ai_api/v1/facade/gptimage.py:173-181`。
- 不把 Bria/AliCloud/Flux/video provider 做进今晚 demo；这些都需要 mivo-server 或独立后端/credential。
- 不把 OD 的 ChatComposer/DesignToolboxPanel 整体搬入画布；只借鉴 action 命名和按钮布局。
- 不把 TB 的 C3/C4 shared api-server 算法并入本 demo 中间件；抠图/资产抽取不是 M1/M2 验收链路。

## 净结论

demo 的居中底部工具条最低应含 `选择/移动`、`生成`、`局部重绘` 三个按钮：`生成` 接 M1 的 `/api/mivo/generate`（参考图仍由 M1 dialog 走 `/api/mivo/edit`），`局部重绘` 接 M2 的 OD-style 框选/画笔 mask overlay 并提交 `/api/mivo/edit`；今晚不碰 mivo-server，只从 MS 抄 `gpt-image-2` 参数映射/edits 形状，从 OD 抄底部工具条和绘制交互。
