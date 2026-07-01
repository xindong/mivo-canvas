GD_REVIEW_DECISION: APPROVED

# 计划审查 #1：契约一致性 + 可执行性 + 锚点真实性

## Findings

1. [P1] `docs/demo/plan/step-M0.md:12`, `docs/demo/plan/step-M0.md:25`, `vite.config.ts:395`  
   问题：M0 计划要求把 key 放进 `.env.local`，但又只让 `readImageApiKey()` 读 `process.env.MIVO_IMAGE_API_KEY`。当前 `vite.config.ts` 是普通 `defineConfig({ plugins: [...] })` 形态，没有在 config 阶段调用 `loadEnv`；按这个计划落地时，`.env.local` 里的非 `VITE_` 变量不会可靠进入 dev middleware 的 `process.env`，`/api/mivo/generate` 和 `/api/mivo/edit` 会直接 500 `MIVO_IMAGE_API_KEY is not set`。  
   具体修法：把 M0 计划改成在 `vite.config.ts` 引入 `loadEnv`，导出 `defineConfig(({ mode }) => { const env = loadEnv(mode, process.cwd(), 'MIVO_'); ... })`，把 `env.MIVO_IMAGE_API_KEY || process.env.MIVO_IMAGE_API_KEY` 传给 `localAssetLibraryPlugin` 或 `readImageApiKey` 的闭包；仍禁止 `VITE_` 前缀，仍禁止前端读取 key。

2. [P1] `docs/demo/plan/step-M1.md:44`, `docs/demo/plan/step-M2.md:7`, `docs/demo/plan/step-M2.md:147`, `docs/demo/plan/step-M5.md:38`, `src/store/canvasStore.ts:180`  
   问题：M1/M2 都要求调用 M5 提供的“写入派生节点+edge 的 store action/helper”，但 M5 的精确改动清单只计划改现有 mock `generate*` action 写 edge，没有新增一个可被真实 b64 流复用的提交入口。当前 store action 面也只有 `generateVariations/generateImageEdit/generateBesideNode/generateIntoAiSlot/generateFromAnnotation`，没有通用 `addDerivedImageNode` 一类动作。按现计划执行，M1/M2 会各自临时拼 node/edge，或卡在找不到契约入口。  
   具体修法：在 M5 明确新增并命名一个唯一入口，例如 `addDerivedImageNode({ sourceNodeId, asset, prompt, model, type, maskBounds, placement, taskId })` 或 `commitDerivedImageResult(...)`；它负责创建 image node、写 `sourceNodeId/generation`、追加 `CanvasEdge`、放位、选中新节点、更新 task。M1/M2 计划改为调用这个确切符号，不再写“例如/若命名不同”。

3. [P2] `docs/demo/plan/master-plan.md:38`, `docs/demo/plan/step-M0.md:15`, `docs/demo/plan/step-M0.md:19`, `docs/demo/plan/step-M1.md:24`, `docs/demo/plan/step-M2.md:60`  
   问题：edit multipart 的 reference 字段名没有统一。master/M2 写 `reference[]`，M0 解析和转发写的是 `reference`，M1 又计划新建 `mivoImageGeneration.ts` 的 `editMivoImage`，M2 再新建 `mivoImageEditClient.ts`。这会让 `/api/mivo/edit` 的 FormData 形状分裂，尤其多参考图可能被中间件忽略；而已验证的 llm-proxy 最小契约只有 `image + mask + model + prompt + size + quality`。  
   具体修法：只保留一个前端 edit client/FormData builder（优先放在 `src/lib/mivoImageGeneration.ts` 或改名为共享 `mivoImageClient.ts`），并把 M0 parser 明确为“接收 `reference[]`，兼容 `reference`”。若 llm-proxy 未验证多图 edits，今晚最小闭环应把额外 references 标成 best-effort 或暂不发送；M1/M2 SC 只依赖第一张 `image` 和 M2 的独立 `mask`。

4. [P2] `docs/demo/plan/master-plan.md:9`, `docs/demo/plan/master-plan.md:16`, `docs/demo/plan/master-plan.md:21`, `docs/demo/PIPELINE.md:15`, `docs/demo/plan/step-M6.md:41`  
   问题：master/PIPELINE 仍写“5 个模块”，但范围里已经加入 M6；master DAG 只排到 M0/M5/M1/M2/M4，没有把 M6 放进执行序。step-M6 自身又依赖 M1 的打开/聚焦能力和 M2 的 `beginMaskEdit`，顺序不明确会导致 M6 提前落地时“局部重绘”只能 disabled，而 master M6-SC1 要求它进入 M2 流程。  
   具体修法：把模块计数统一为 6 个；在 master DAG 中显式加入 M6，建议 `M6-shell` 可在 M1 后做“选择/生成”，完整 `M6-SC1 局部重绘` 必须排在 M2 plumbing 之后验收。若不拆 shell，就把 M6 排到 M2 后。

5. [P3] `docs/demo/plan/step-M0.md:20`, `vite.config.ts:225`, `vite.config.ts:314`  
   问题：M0 新路由计划使用 `if (url === '/api/mivo/generate')` / `edit`，但现有 Eagle assets 路由已经用 `startsWith` 并解析 query。生成端点当前 SC 不带 query，可跑通；但后续如果前端加调试参数或 cache-buster，等值判断会掉到 `next()`。  
   具体修法：M0 路由统一用 `const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')`，按 `requestUrl.pathname` 精确匹配 `/api/mivo/generate`、`/api/mivo/edit`。

## 锚点真实性核验

- 已确认真实且语义匹配：`AIToolPanel.runPrimaryGeneration` 在 `src/app/AIToolPanel.tsx:67`，当前无 selection 只建 slot 不生成，M1 修改点真实。
- 已确认真实且语义匹配：`CanvasNodeView` props 在 `src/canvas/CanvasNodeView.tsx:10`，image 渲染在 `src/canvas/CanvasNodeView.tsx:674`，`<img>` 在 `src/canvas/CanvasNodeView.tsx:686`，M2 overlay 挂载点真实。
- 已确认真实且语义匹配：`useCanvasInteractionController` options 在 `src/canvas/useCanvasInteractionController.ts:53`，Escape 在 `:1235`，Cmd+C 在 `:1294`，paste 在 `:1371`，M2/M4 接入点真实。
- 已确认真实且语义匹配：`CanvasToolDock` 在 `src/canvas/CanvasToolDock.tsx:15`，`canvasToolRegistry` 在 `src/canvas/canvasToolRegistry.ts:44`，M6 “不并入 registry”判断成立。
- 已确认真实且语义匹配：`localAssetLibraryPlugin` middleware 入口在 `vite.config.ts:221`，Eagle assets endpoint 在 `vite.config.ts:314`，当前无 `/api/mivo/generate`、`/api/mivo/edit`、`/api/mivo/eagle/tags`，M0/M4 新增点真实。
- 已确认真实且语义匹配：`MivoCanvas.handleCanvasDrop` 在 `src/canvas/MivoCanvas.tsx:327`，payload 分支调用 `importImageUrlToCanvas` 在 `:342`，helper 定义在 `src/lib/canvasAssetImport.ts:406`，M4 drag/drop 复用链路真实。
- 已确认真实且语义匹配：`chooseAdjacentPlacement` 在 `src/store/aiCanvasWorkflow.ts:39`，M1/M2/M5 放位复用点真实。
- 已确认当前缺失且计划需补：`CanvasEdge/edges/sourceNodeId` 当前不在 `src/types/mivoCanvas.ts:101`、`:194`、`:221`、`:230`；`canvasStore` 当前 state 无 `edges`（`src/store/canvasStore.ts:39`），snapshot/persist 也无 edges（`:241`、`:2157`）。M5 的数据模型变更是必要前置。

## 契约核验结论

- gpt-image-2 生成契约与已验证 llm-proxy 一致：master 的 `/api/mivo/generate` JSON `{model,prompt,n,size,quality}` 对应 PIPELINE `POST /v1/images/generations`。
- gpt-image-2 edits mask 契约方向正确：M2 计划明确原图自然像素尺寸 mask，`透明=要改、不透明=保留`，并独立 multipart `mask`，与 PIPELINE 已验证契约一致。
- size 映射来源一致：M0 指向 reuse-inventory 表，包含 `1:1/3:2/2:3/16:9/9:16 × low/medium/high`，默认 medium；未发现比例/质量契约冲突。
- 主要阻断在 M0 env 可执行性与 M5 shared commit action 缺口；修完后再进执行更稳。

## Round 2

### Decision

GD_REVIEW_DECISION: APPROVED

第 1 轮 P1/P2 已按计划层面修复：M0 key 加载、M5 共享提交 action、M1/M2 共享 client、M6 master DAG 都已对齐。当前源码仍是执行前基线，复核重点是计划是否指向真实锚点、是否会把后续实现带到一致契约。

### Resolved Checks

- M5 共享提交 action：`docs/demo/plan/step-M5.md:4` 已定义唯一 `commitGenerationResult(...)`；`docs/demo/plan/step-M5.md:21` 把它加入 `CanvasState`；`docs/demo/plan/step-M5.md:41` 明确在 action 内完成 b64/blob→`saveGeneratedAsset`→`chooseAdjacentPlacement`→新 image node→`CanvasEdge`→一次性 patch，失败不写半成品。M1 在 `docs/demo/plan/step-M1.md:24`、`:25`、`:26` 均改为拿到 response 后只调用 `commitGenerationResult(...)`；M2 在 `docs/demo/plan/step-M2.md:102`、`:149`、`:212` 也只调用同一 action，不再各自拼 node/edge。
- M0 key 加载：`docs/demo/plan/step-M0.md:9` 引入 `loadEnv`，`:20` 把 `localAssetLibraryPlugin` 改成 `{ imageApiKey }` 闭包，`:23` 使用 `loadEnv(mode, process.cwd(), '')` 后只把 `imageApiKey` 传给 Node plugin。当前源码替换点真实：`vite.config.ts:395` 仍是 plain `defineConfig`，`.gitignore:29` 已覆盖 `.env.local`；计划没有把 key 放进 `define`、`import.meta.env` 或 `VITE_`。
- 单一共享 client：`docs/demo/plan/step-M1.md:17` 新建唯一 `src/lib/mivoImageClient.ts`，并禁止 `mivoImageEditClient.ts`；`:18` 明确 `image`、`mask`、`reference[]` 三个字段语义；M2 在 `docs/demo/plan/step-M2.md:60` 复用同一模块。当前源码中 `src/lib/mivoImageClient.ts` 尚未实现是预期执行状态；`rg` 未发现已有第二套 `mivoImageEditClient`。
- M6 进 master：`docs/demo/plan/master-plan.md:9`、`:10` 已改为 6 个模块，`:21`-`:28` DAG 已加入 M6，`:34` 明确 M6 完整验收排在 M2 plumbing 后，`:69` 增加 M6-SC1。
- 锚点复核：本轮再次核对 `CanvasNodeView` image branch、`useCanvasInteractionController` Escape/paste、`CanvasToolDock`/`canvasToolRegistry`、`MivoCanvas.handleCanvasDrop`、`chooseAdjacentPlacement` 等源码锚点，仍真实且语义匹配。

### Findings

1. [P3] `docs/demo/PIPELINE.md:15`, `docs/demo/PIPELINE.md:60`  
   问题：master 已改为 6 模块，但 PIPELINE 仍有旧文案“做（5 模块）”和 P1 “五模块”历史描述。它不再阻断 master/step 执行契约，但作为 overnight loop 真相源，会让后续状态汇报继续出现 5/6 计数不一致。  
   具体修法：把 `docs/demo/PIPELINE.md:15` 改为“做（6 模块）”；`docs/demo/PIPELINE.md:60` 改为覆盖 6 模块或改成“不写模块数”的历史描述。

2. [P3] `docs/demo/plan/step-M5.md:14`, `docs/demo/plan/step-M5.md:41`  
   问题：`CommitGenerationResultPayload.sourceNodeId` 仍是可选，且无 source 时 `commitGenerationResult` 允许 `{x:0,y:0}` 放置并不创建 edge。M1/M2 计划已经强制传 source（空画布先建 ai-slot，M2 传原 image），所以不阻断 demo；但它给后续误用留下“生成结果无 edge”的旁路。  
   具体修法：执行时优先把 `sourceNodeId` 改成必填；若确实保留无 source fallback，注释限定为非 demo/import 场景，并在 M1/M2 action 入口 assert source 存在后再调用。

### Round 2 Net

残留阻断：无。P1=0，P2=0。仅有两个 P3 文档/收口建议，不影响进入执行。
