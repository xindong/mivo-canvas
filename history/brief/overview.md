---
anchor: 3d527cf7fb140f9e6a9096446a3d88813fd95151
generated: 2026-07-07
---
# Project MivoCanvas 全景简报

## 定位
桌面式 AI 艺术画布交互 Demo（Vite 8 + React 19 + TS + LeaferJS 2.1 + Zustand 5）：无限画布 + FigJam 风格标注 + AI 图像生成工作流。产品范式 = 人 ↔ agent / 图（锚点）对话；生图任务统一落对话框卡片。是老 mivo 的产品形态迭代验证场，mivoserver 定位为可复用能力层。双进程拓扑：Vite 前端 + BFF（`server/`，tsx 运行，代理 mivo 生图任务）。主仓 github.com/xindong/mivo-canvas，main 分支保护（PR + 6 项 CI 必绿），一律从 feature 分支提 PR。

## 功能地图（现状基线）

**渲染引擎（Leafer 正式化，30+ PR 收官）**
- 默认渲染器已切 leafer，`?renderer=dom` 应急回退，双轨代码保留（`#131`）
- 终局架构 = 虚拟化冻结 + LOD + Leafer paint + DOM 混合：image/frame/rect/ellipse/note/line/arrow/connector/brush/stamp 十类 paint 走 Leafer（`#110` `#112` `#116` `#120`），静态文本经 golden fixture 判决永久留 DOM（`#121`），markup 文字层与 frame 标题以 DOM overlay/纯标题壳恢复（`#124` `#125`），选中态外框保留纯选中 DOM 壳（`#132`）
- stamp（表情）原生动效 + z-order 三轨一致：stamp 留 Leafer 并原生还原动效，新增 zRank 单一策略源，stamp renderOrder=1 恒高于 image（含 selected 态）（`#140`）；Leafer 表情选中框修复（`#141`）；默认轨兜底 + per-node 签名 + window 探针 DEV 门控（R-01/R-02）
- RendererAdapter 契约：相机单向同步、z-order 统一（layer/renderOrder/surface + 4 级 hit-test）、mask/crop overlay 解耦到 EditOverlayLayer（`#100` `#101` `#104`）
- 性能门禁：20k 节点 worst-DPR pan p95 复验 26.7ms，line LOD 保 20k pan gate（`#128`）；引擎选型史见 spike 收官 `#85` `#92` `#93` `#96` `#98`（Pixi NO-GO，Leafer GO）

**AI 生图工作流**
- 对话框生图：占位卡片 → BFF 轮询 → 结果落对话框卡片 + 画布；占位符恒 1:1 方形，替换按结果比例等面积落画布（`#102` `#105`）
- 局部重绘（mask edit）：并入对话生图卡片链路（enhance agent + 取消 + 结果落对话框 `#95`），质量四档选择器（`#89`），坐标 pin/锚点标记/镜头跟随（`#99`），二次重绘黑块自愈（`#97`），超时分级 + Retry CTA（`#103`）
- 图片编辑：裁剪、蒙版、异步提速、黑盘自愈、外链代理（`#87`）

**画布交互与标注**
- FigJam 式标注：brush/stamp/文字标注/line/arrow/connector、选中快捷工具条、右键菜单、frame 分组
- **项目目录管理复刻到侧栏（`#142`，本轮最大新功能）**：项目 CRUD + 画板/项目右键菜单 + 项目间移动归类，替换原硬编码 demo 侧栏（demo 项目改由 store 初始化 seed，含防重激活护栏）
- shell 统一 dispatch + pointer-events 白名单（`#88`）、编辑态 dispatch 契约（`#79`）、拖拽写路径 O(n) 优化（`#86`）

**持久化与数据安全**
- Zustand persist → IDB 适配器 + 迁移器 + hydration gate（`#84` `#90`）；快照校验、僵尸生成防误判（`#76`）、回滚吞编辑/假成功/消息丢失五连修（`#81`）；chat isBusy 第二道 return 不丢输入 + 清 chatMaskEditFlow（提交级修复）
- 资产 URL 引用计数 lease API + 拒绝时清理中毒缓存（`#78` `#133`）；naturalSize 服务 + 投影字段（`#82`）

**BFF 与外围能力**
- BFF 访问门（access gate）：多方案认证，新增 HTTP Basic Auth 分支修复浏览器直开首页被 401（fix `#136`，提交 3d527cf）；proxy-image SSRF 加固——pin IP + 相对 Location + poll abort 等待（提交级）
- 素材库工作区（LibraryWorkspace，本地目录 + Eagle 接入）、Inspector 面板
- 侧边栏更新日志面板 + generate-changelog skill 自动补扫（`#107` `#109` `#115` `#143`）
- Debug Log 体系（debugLogger + toastFeedback 强制约定）+ 日志规则守卫脚本；部署脚本：一键合并 + 部署到 L20-1（`#139`）

## 代码地图
| 目录 | 职责 |
|---|---|
| `src/canvas/` | 画布交互层：MivoCanvas 主容器 / CanvasNodeView 节点渲染 / ImageMaskEditOverlay 局部重绘 / actions 动作模型（canvasActionModel 1320 行） |
| `src/render/` | 渲染双轨：DomRenderer + leafer*Paint 系列 + hitTest + interactionAdapter + LOD/culling + zRank 单一策略源 |
| `src/store/` | Zustand 状态：canvasStore / chatStore / generationSlice / canvasDocumentModel / hydration 系列（P2-A2 后 canvasStore 已做类型抽取瘦身） |
| `src/model/` | 纯数据模型：documentModelV2 / anchorModel / aiCanvasCommands |
| `src/app/` | 外壳 UI：LibraryWorkspace（1316 行）/ ProjectSidebar（项目 CRUD/右键菜单/移动）/ InspectorPanel / ChangelogPanel / chat/ |
| `src/lib/` | 客户端服务：mivoTaskClient / assetStorage / assetUrlLease / persistIdbStorage / maskResultInspection |
| `server/` | BFF：app.ts（access gate）+ routes/tasks/platform/lib，代理 mivo 生图 + 本地资产目录 + Eagle + proxy-image |

数据流：Zustand store（canvas/chat 两主 store，persist→IDB）为单一事实源；画布动作经 canvasActionModel dispatch 改 store；渲染层经 RendererAdapter 订阅投影（projection）绘制，相机单向同步。
热区：`canvasActionModel.ts`(1320) `LibraryWorkspace.tsx`(1316) `chatStore.ts`(875) `generationSlice.ts`(838) `useLeaferSpikeRenderer.ts`(821) `MivoCanvas.tsx`(800)。

## 命令与状态
- 开发：先 `npm run start:server`（BFF）再 `npm run dev`；构建 `npm run build`（tsc -b + vite）；lint `npm run lint`
- 测试：`npm run test:unit`（vitest）/ `npm run test:e2e`（Playwright dev 拓扑）/ `verify:logging` 日志守卫 / `contract:diff` / `codemap`
- 分支 `main` @ `3d527cf`（2026-07-07），与 origin/main 同步 ✅
- CI：ci.yml + nightly-e2e + secret-scan + Structure Guard（baseline.json）；main 保护 PR + 6 项检查必绿（strict 已关，强制 resolve 线程来自组织层 ruleset trunk-guard，member 无权改）
- 待决事项：双轨 DOM 渲染器删除待观察窗后决策；工作区有未跟踪的 TECH_DEBT_AUDIT.md + docs/plan/p0p1-debt-fix-execution-plan.md；生产服务器（10.102.80.15）存在未纳管的"区域描述/蒙版编辑"未提交改动待团队确认

## 延伸阅读
- `docs/architecture.md` + `src/render/README.md` — 动渲染层/加节点类型前读（双轨与契约细节）
- `docs/mivo-data-model-v2.md` — 改 store/持久化结构前读
- `docs/product-notes.md` — 判断产品方向与交互范式时读（README 为产品说明勿覆盖）
