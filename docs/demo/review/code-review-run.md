GD_REVIEW_DECISION: REQUIRES_CHANGES

# P5 Code Review Run #1

## Findings

### [P1] M2 `框选` / `涂抹` 无法形成 mask region，M2-SC3 未通过

- 涉及文件：`src/canvas/ImageMaskEditOverlay.tsx:155-210`
- 问题：5173 运行态下，`点选` 能创建 region 并提交，但 `框选` 和 `涂抹` 使用真实鼠标拖拽后 `.image-mask-edit-region` 仍为 0，提示仍停在“先在图片上点选、框选或涂抹要修改的区域。”，提交按钮保持 disabled，未发出 `/api/mivo/edit`。
- 复现：打开 `http://127.0.0.1:5173/`，默认选中 `ref-hero`；点底部 `局部重绘`；选择 `框选`，从图片左上拖到右下；或选择 `涂抹`，按住鼠标划线。两者都不会生成 region。对照：同一入口选择 `点选`，单击后 regionCount=1，输入 prompt 后可提交。
- 期望：`框选` pointer up 后提交一个 box region；`涂抹` pointer up 后提交一个 brush region；二者都能启用 prompt 提交并走 `/api/mivo/edit`。
- 具体修法：不要只依赖 React state 闭包中的 `draft` 完成拖拽状态机。用 `useRef` 保存当前 pointer draft（pointerdown 写入、pointermove 更新、pointerup 读取并 commit），state 只负责渲染；同时补 Playwright 用例覆盖 `点选/框选/涂抹` regionCount 和 submit enabled。

### [P3] Eagle tag 目录会列出点击后无图片的 tag，demo 首个 tag 容易空屏

- 涉及文件：`vite.config.ts:591-604`、`vite.config.ts:647-660`、`src/app/LibraryWorkspace.tsx:723-759`
- 问题：`/api/mivo/eagle/tags` 直接返回 Eagle 全局 tag 列表；`/api/mivo/eagle/assets` 再过滤 image 扩展。实跑中 `Regular` 请求 `/api/mivo/eagle/assets?tag=Regular` 返回 200 但瀑布流 0 张；`UI Design` 返回 75 张。
- 影响：M4-SC2 的可用 tag 能通过，但 demo 用户顺手点前几个 font/style tag 时会看到空瀑布流。
- 具体修法：tag 目录只展示 image-filtered assets 中 count > 0 的 tags，或把非空 tag 带 count 排到前面。

## Run Evidence

- Build：上一轮 `npm run build` 已通过；关键结果为 `tsc -b && vite build`，Vite `8.0.16`，`2068 modules transformed`，仅 chunk size warning。
- M1 文生图（5173 独立实跑）：空画布 0 image；右下 prompt 输入 `a flat simple blue square icon centered on a plain white background`，quality=`low`；`/api/mivo/generate` 200，请求 JSON 含 `{model:"gpt-image-2", imgRatio:"1:1", quality:"low", n:1}`；生成 `generate-result-...` 新 image，保留 `ai-slot-...`，edge 为 slot -> result。
- M1 图生图（5173 独立实跑）：上传 `mivo-p5-m1-ref.png` 出现 reference chip；`/api/mivo/edit` 200，FormData 含 `image 1024x1024`、`reference[] 128x128`、`prompt`、`imgRatio=1:1`、`quality=low`、`model=gpt-image-2`，无 `mask`；生成第二张新 image，edge 为第一张 result -> 第二张 result。
- M2 点选（5173 独立实跑）：默认 `ref-hero` 进入 `局部重绘`，`点选` 单击后 regionCount=1，prompt 后 `/api/mivo/edit` 200。FormData：`image 1080x1920`、`mask 1080x1920`、`imgRatio=9:16`、`quality=medium`、`model=gpt-image-2`。mask alpha：transparent=7038、opaque=2066222、semi=340，符合“透明=要改、不透明=保留”。结果新增 `edit-result-...`，source `ref-hero` 仍在，edge `ref-hero -> edit-result` 可见，result `maskBounds={x:492,y:912,width:96,height:96}`。
- M2 框选 / 涂抹（5173 独立实跑）：真实拖拽后 regionCount=0，submit disabled，未发 `/api/mivo/edit`，因此不能满足“三种交互都能生成有效 mask 并影响重绘区域”。
- M4 Eagle：真实 Eagle `127.0.0.1:41595` 在线；瀑布流初始 112 cards；`UI Design` tag 切换后 75 cards；lightbox、右键单图复制 paste +1、多选 2 张复制 paste +2、拖拽 card 到画布 +1 均跑通。卡片正文只显示标题、格式、尺寸、大小，未渲染每图 tag chips。
- M5：M1 与 M2 点选结果均为新增 image node，source/slot 不覆盖；运行态 edge 数据和可见 arrow markup 均存在。
- M6：底部居中工具条存在；`生成` 打开并聚焦右下 prompt textarea；选中 image 时 `局部重绘` 进入 M2 overlay；1440x980 下工具条未与 sidebar、zoom controls、AI panel 重叠。

## SC Matrix

- M0-SC1：PASS。M1 触发 `/api/mivo/generate` 返回真实 b64 image。
- M0-SC2：PARTIAL。`点选` 的 `/api/mivo/edit` image+mask 返回真实编辑图；`框选/涂抹` 因 UI 无法形成 region，未能发起真实 edit。
- M0-SC3：PASS。浏览器请求只打本地 `/api/mivo/*`；build 产物未检出 `MIVO_IMAGE_API_KEY|llm-proxy|Authorization|Bearer`。
- M1-SC1：PASS。空画布 prompt 后出现 1 张真实图。
- M1-SC2：PASS。参考图 chip + prompt 后走 `/api/mivo/edit` 图生图并出现新图。
- M2-SC1：PARTIAL。`点选` 可生成新图且原图仍在；`框选/涂抹` 不能提交。
- M2-SC2：PASS for `点选`。新图与原图之间有可见派生 edge。
- M2-SC3：FAIL。`框选`、`涂抹` 拖拽后未生成 mask region。
- M4-SC1：PASS。
- M4-SC2：PASS with P3 demo risk。
- M4-SC3：PASS。
- M4-SC4：PASS。
- M4-SC5：PASS。
- M5-SC1：PASS for M1 and M2 `点选`; blocked for full M2 because M2-SC3 fails。
- M6-SC1：PASS。

## Round 2

### Decision

GD_REVIEW_DECISION: REQUIRES_CHANGES

Round 1 的 P1（`框选` / `涂抹` 拖拽 regionCount=0）在 `5e6b8bf` 复核中已修复；本轮整体仍是 `REQUIRES_CHANGES`，原因是下面两个 P2 仍未修。

### Findings

#### [P2] M2 横图默认尺寸下 mask 控件覆盖整个图片，无法标注区域

- 涉及文件：`src/canvas/ImageMaskEditOverlay.tsx:319`、`src/canvas/ImageMaskEditOverlay.tsx:367`、`src/canvas/ImageMaskEditOverlay.tsx:412`、`src/App.css:4070`、`src/App.css:4113`、`src/App.css:4193`
- 问题：默认导入的 16:9 横图节点显示为 `360x203`。进入 `局部重绘` 后，顶部 toolbar 和底部 prompt 都绝对定位在同一个 image node 内，命中测试显示从 `y=0.05` 到 `y=0.92` 基本都被 `.image-mask-edit-toolbar` / `.image-mask-edit-prompt` / `.canvas-ai-action-bar` 覆盖；点击图片中心命中 `TEXTAREA`，`data-region-count=0`，提交 disabled，未发 `/api/mivo/edit`。
- 复现：运行态添加一张 `1600x900` 横图（展示尺寸 `360x203`）→ 选中 → 底部 `局部重绘` → 点选图片中心。实际：命中 prompt textarea，regionCount 仍为 0。对照：默认竖图 `ref-hero` 的点选/框选/涂抹均可 regionCount=1 并真实提交。
- 影响：Round 2 要求的 “M2 非方图横图重绘不变形” 无法进入提交阶段；横图素材是 Eagle / 本地导入的常见路径，M2 对横图仍不可用。
- 具体修法：把 M2 toolbar/prompt 从 image node 内移出，改为 canvas-level floating controls，或至少在短图/横图时放到节点外侧；可保留 stage 全区域接收 pointer，仅 controls 本身 `pointer-events:auto`。补一条 Playwright 覆盖：导入默认 `16:9` 横图，点/框/涂抹至少一种能 `regionCount>0`，请求 `imgRatio=16:9`，结果节点保持横向比例。

#### [P2] Eagle 素材拖拽到画布仍未打通，drawer backdrop 截获 drop

- 涉及文件：`src/App.tsx:180`、`src/App.tsx:184`、`src/app/LibraryWorkspace.tsx:924`、`src/app/LibraryWorkspace.tsx:934`、`src/canvas/MivoCanvas.tsx:540`、`src/canvas/MivoCanvas.tsx:541`
- 问题：Eagle card 已设置 `draggable` 和 `onDragStart`，但 Assets drawer 打开时 `.asset-library-drawer-backdrop` 覆盖整个 canvas shell（运行态 bbox：canvas shell `x=240,w=1200`；backdrop 同尺寸且 `z-index=72`）。`MivoCanvas` 的 `onDrop` 只挂在被遮住的 `.canvas-shell` 上；把 card drag 到 drawer 左侧画布区域后 8 秒内 nodes 仍 `3 -> 3`。
- 复现：打开 `Assets` → `Eagle libraries` → 拖第一张 `.asset-masonry-card` 到画布区域；或 Playwright `dragTo(.canvas-shell, force:true)`。实际：无新增 image node。对照：同一轮右键 `Copy` → 回 Canvas → `Cmd+V` 可以 `3 -> 4`。
- 影响：M4-SC3 “拖动素材卡到画布生成 image node” 不成立；Eagle 链路只能靠复制粘贴完成。
- 具体修法：给 `asset-library-drawer-backdrop` 增加 local asset `dragover/drop` 转发，或在拖拽期间让 backdrop 不截获 pointer/drop，并确保 drop 坐标转换为 canvas 坐标后复用 `importImageUrlToCanvas(...)`。补验收：drawer 打开状态下从 `.asset-masonry-card` 拖到左侧 canvas 区，nodes +1。

### Round 2 Run Evidence

- Commit / dev：`git rev-parse --short HEAD` 为 `5e6b8bf`；`127.0.0.1:5173` 返回 200；dev server served `src/canvas/ImageMaskEditOverlay.tsx` 含 `regionsRef` / `draftRef` / `data-region-count` 修复代码，无需重启。
- M2 三交互真拖拽（默认竖图 `ref-hero`，真实 `/api/mivo/edit`）：`点选` 也按 mouse down/move/up 跑，regionCount=1，submit enabled，`/api/mivo/edit` 200，image/mask `1080x1920`，mask alpha `transparent=7038, opaque=2066222, semi=340`，新增 `edit-result-1782938300260-0148ec`，edge `ref-hero -> edit-result`；原 `ref-hero` 仍在。
- M2 三交互真拖拽（默认竖图 `ref-hero`，真实 `/api/mivo/edit`）：`框选` 真实鼠标拖出矩形，regionCount=1，submit enabled，`/api/mivo/edit` 200，mask alpha `transparent=69671, opaque=2003929, semi=0`，新增 `edit-result-1782938363036-b33802`，edge `ref-hero -> edit-result`；原 `ref-hero` 仍在。
- M2 三交互真拖拽（默认竖图 `ref-hero`，真实 `/api/mivo/edit`）：`涂抹` 真实鼠标按住涂一笔，regionCount=1，submit enabled，`/api/mivo/edit` 200，mask alpha `transparent=46981, opaque=2025259, semi=1360`，新增 `edit-result-1782938452846-f97eb3`，edge `ref-hero -> edit-result`；原 `ref-hero` 仍在。
- Mask 语义：三次真实 edit 的 mask 都是 `透明像素 > 0` 且 `opaque` 覆盖其余大部分区域，符合 “透明=要改、不透明=保留”；payload 字段均为 `image` + `mask` + `prompt` + `imgRatio=9:16` + `quality=medium` + `model=gpt-image-2`。
- M1 文生图 no-regression smoke：拦截 `/api/mivo/generate` 返回合法 b64；空画布 prompt 后请求 JSON `{prompt,imgRatio:"1:1",quality:"medium",n:1,model:"gpt-image-2"}`，nodes `0 -> 3`，新增 image + `generate` edge，结果节点被选中。Round 1 已覆盖真实 llm-proxy 200。
- M1 图生图 no-regression smoke：上传 reference chip 后走 `/api/mivo/edit` multipart，FormData 有 `image`、`reference[]`、`prompt`、`imgRatio`、`quality`、`model`，无 `mask`；nodes `3 -> 5`，新增 image + edit/generate 派生关系，reference chip 成功后清空。
- 生成错误 / retry：模拟 `/api/mivo/generate` 504，UI 进入 error，slot `status=failed`，显示 `重试`；点击 `重试` 后第二次 200，nodes `1 -> 3`，edge + result image 正常。
- 生成 cancel：模拟慢 `/api/mivo/generate` 后点击 `取消`，fetch abort，UI 显示 `图片请求已取消。`，5.5s 后仍无 result image / edge。
- 生成空 b64：模拟 200 `{images:[{b64:""}]}`，UI 显示 `Image service returned an invalid response`，只保留 failed slot，无坏 image node / edge。
- 编辑错误 / retry：模拟 `/api/mivo/edit` 504，M2 overlay 显示 `simulated edit timeout`，regions/prompt 保留且提交按钮重新可点；第二次提交 200 后新增 image + `edit` edge。
- 编辑 cancel：模拟慢 `/api/mivo/edit` 后点击 `Cancel mask request`，overlay 关闭，fetch abort，5.5s 后 nodes `3 -> 3`、edges `0 -> 0`。
- 编辑空 b64：模拟 200 `{images:[{b64:""}]}`，M2 overlay 显示 `Image service returned an invalid response`，nodes `3 -> 3`、edges `0 -> 0`。
- 非方竖图：默认 `ref-hero` 为 `1080x1920`，三次真实 M2 edit 均发送 `imgRatio=9:16`，结果显示为竖向节点约 `203x360`，未覆盖原图。
- 非方横图：默认导入 `1600x900` 横图显示为 `360x203`，进入 M2 后控件覆盖图片导致 regionCount=0，见 P2。
- Eagle no-regression：Eagle status `connected=true`、`version=4.0.0`；`/api/mivo/eagle/tags` 返回 tag 目录；`UI Design` tag endpoint 有 75 assets。浏览器中 `Eagle libraries` 初始 cards=112，点 `UI Design` 后 cards=75，lightbox 可打开，右键 Copy 后回 Canvas `Cmd+V` nodes `3 -> 4`。
- M6 no-regression：底部 `生成` 能打开 M1；底部 `局部重绘` 能进入 M2 overlay；默认竖图三交互均通过该入口完成。未发现遮挡 sidebar / zoom 的新问题。

### Round 2 SC Matrix

- M0-SC1：PASS。Round 1 已真实 llm-proxy；Round 2 M1 client smoke 仍按 `/api/mivo/generate` JSON 契约发请求。
- M0-SC2：PASS。Round 2 三次真实 `/api/mivo/edit` 均 200，multipart image+mask 字段正确。
- M0-SC3：PASS by Round 1 build/key check；Round 2 未改 M0 / build 配置。
- M1-SC1：PASS。空画布 prompt 后新增 slot + image + generate edge。
- M1-SC2：PASS。reference chip 走 `/api/mivo/edit`，无 mask 字段，成功生成新 image。
- M2-SC1：PARTIAL。默认竖图点/框/涂抹均新建 result 且原图仍在；默认横图因控件覆盖无法标注。
- M2-SC2：PASS for default vertical image。三次真实 edit 均有 `ref-hero -> result` 可见派生 edge。
- M2-SC3：PASS for original P1 scope。点选 / 框选 / 涂抹真拖拽均 regionCount=1 并提交 200；横图另见 P2。
- M4-SC1：PASS。Eagle tag 目录 + 瀑布流可见。
- M4-SC2：PASS。`UI Design` tag 切换后 75 cards。
- M4-SC3：FAIL。Eagle card 拖到 canvas 未新增 node，见 P2。
- M4-SC4：PASS。点击 card 可打开 lightbox。
- M4-SC5：PASS for single-copy rerun；multi-copy 维持 Round 1 通过结果。
- M5-SC1：PASS for M1 and default vertical M2。生成/编辑产物均为新 node + edge，source 不覆盖；横图路径 blocked by M2 overlay。
- M6-SC1：PASS。底部工具条入口能触发 M1 / M2，布局未见新遮挡。
