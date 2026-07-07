# Mivo Canvas

AI-native 的无限画布交互 Demo:以桌面级无限画布为基座,面向视觉创作、评审与素材工作流。原始素材永不破坏,生成结果保留在画布语义中,画布内容对 AI Agent 可读。

> 目前处于 Demo / 架构验证阶段,尚非生产产品。

## 功能

- **无限画布**:平移缩放、框选、吸附对齐、行/列/网格排布、Section 分区、编组、undo/redo
- **绘图标注**:画笔(marker / 荧光笔 / 橡皮擦,基于 perfect-freehand 的压感笔迹)、箭头/形状/便签、可绑定对象的连接线、FigJam 式印章
- **资源节点**:图片 / Markdown / PDF / 视频,原始文件存 IndexedDB,支持非破坏性裁剪;资源库对接 Local 文件夹与 Eagle
- **AI 能力**:文生图 / 图生图、mask 局部重绘、生成结果与源图的衍生关系、AI 可读的画布快照
- **归档**:Mivo JSON 导入/导出,内嵌本地资源

## 快速开始

本地开发需要两个进程:BFF 提供 `/api/mivo/*`,前端 dev server 只负责页面与代理。

```bash
npm install

# 终端 A:BFF(API,默认 http://127.0.0.1:8080)
npm run start:server

# 终端 B:前端(Vite,默认 http://127.0.0.1:5173/)
npm run dev
```

`npm run dev` 会把 `/api/mivo/*` 代理到 BFF。只启动前端时,页面能打开,但 AI 生图 / debug logs / 本地资产等 API 会不可用。

AI 生图为可选功能:密钥由 BFF 进程读取,不会进入前端 bundle。BFF 不会自动加载 `.env.local`,启动前需要把环境导入 shell:

```bash
set -a && source .env.local && set +a && npm run start:server
```

常用环境变量:

| 变量 | 作用 |
|------|------|
| `MIVO_IMAGE_API_KEY` | llm-proxy 图像生成 / 编辑密钥 |
| `MIVO_PLATFORM_KEY` | Mivo 平台图像通道密钥(`mivo_` 前缀) |
| `MIVO_PLATFORM_ENDPOINT` | Mivo 平台 endpoint,默认 `https://aigc.xindong.com` |
| `MIVO_PORT` | BFF 监听端口,默认 `8080`;改端口时前端进程也要带同一变量 |
| `MIVO_BFF_DEV_URL` | Vite dev server 代理目标;默认按 `MIVO_PORT` 推导为 `http://127.0.0.1:8080` |
| `MIVO_BFF_TOKEN` | BFF 访问门 token;本地默认不设,公网模式必须设置 |

完整说明见 [server/README.md](server/README.md) 与 [BFF 部署文档](docs/bff-deployment.md)。

其他命令:

```bash
npm run build                  # tsc -b + Vite production build
npm run lint                   # ESLint
npm run preview                # 预览 production build
npm run test:unit              # Vitest 单元测试
npm run verify:logging         # Debug Log / toast 规则守卫
npm run test:e2e               # 默认 dev 双进程拓扑 e2e
npm run test:e2e:dev           # dev 拓扑 e2e
npm run test:e2e:prod:subset   # production+BFF 子集 e2e(mock upstream)
npm run test:e2e:prod:full     # production+BFF 全量 e2e(mock upstream)
npm run test:e2e:prod          # build 后跑 production 拓扑 e2e
npm run test:e2e:gated:unauthorized  # BFF token gate 未授权 e2e
npm run test:e2e:gated:authorized    # BFF token gate 已授权 e2e
npm run start:server           # 启动 BFF(Hono + @hono/node-server)
npm run contract:diff          # BFF 契约 diff
npm run bench:fixtures         # 生成性能基准 fixtures
npm run bench:collect          # 收集性能基准数据
npm run debug:server           # 本地 Debug Log 读取服务
```

## 技术栈

React 19 · TypeScript · Vite · Zustand · Hono + @hono/node-server · perfect-freehand · react-markdown

## 贡献流程

给协作者看的两句话: `main` 有分支保护,所有改动都从分支提 PR,不要直接推 `main`。PR 合并前必须等 6 项 CI 全绿;如果红了,把失败日志交给 AI 助手,让它读日志并修到全绿。

给 AI 助手看的细节:

- 开工先从最新 `origin/main` 拉分支,提交后 push 分支并创建 PR。
- 提 PR 前本地先跑四件套:`npx tsc -b`、`npm run lint`、`npm run test:unit`、`npm run verify:logging`。
- PR 必须通过 6 项检查:`lint + tsc + unit + logging`、`structure guard (anti-regression)`、`e2e prod subset (mock upstream)`、`e2e token gate (unauthorized)`、`e2e token gate (authorized)`、`secret scan (gitleaks)`。
- 若任一检查失败,先读对应 job 日志,修复后重新 push;不要绕过保护,管理员也不豁免。

## 本地验证 / pre-push

推送前自动跑五道本地验证,把"推上去才发现 tsc 都没过"这类问题挡在本地。背景:PR #146 作者推送前没跑任何本地验证(类型错误 + 整个模块漏提交),而 GitHub 对存在冲突的 PR 不触发 `pull_request` CI,问题被静默掩盖,直到 review 才暴露。

- **怎么生效**:`npm ci` / `npm install` 时自动执行 `prepare` 脚本,运行 `git config core.hooksPath .githooks`,把 `.githooks/` 目录接线为 git hook 目录。CI 与服务器跑 `prepare` 也无害(只改本地 git 配置)。
- **跑什么**:`git push` 触发 `.githooks/pre-push`,执行 `npm run preflight`,按快→慢依次:`tsc -b` → `npm run lint` → `npm run verify:logging` → `node scripts/ci/structure-guard.mjs` → `npm run test:unit`。任一失败即阻止 push。
- **附带警示(不阻断)**:若 `git status` 里有未跟踪的 `src/**/*.ts(x)` 文件,打印黄色警告,提示确认是否漏 `git add`(本次事故正是整个模块漏提交)。
- **怎么跳过**:仅在确认非代码问题(如紧急修复 CI 配置本身)时,用 `PREFLIGHT_SKIP=1 git push` 逃生。日常开发不要跳。`git push --no-verify` 同样会绕过本 hook(git 原生机制,无法禁止),但它静默无提示、不留任何记录,不推荐;需要跳过时请显式用 `PREFLIGHT_SKIP=1 git push`,意图可见。
- **手动接线**(老仓库或未跑过 install 时):`git config core.hooksPath .githooks`,或直接 `npm run prepare`。

## 文档

- [产品与架构笔记](docs/product-notes.md)
- [数据模型 v2](docs/mivo-data-model-v2.md)
- [Debug Log 与反馈规则](docs/development-logging.md)
- [开发决策记录](docs/development-record.md)
- [BFF 部署文档](docs/bff-deployment.md)
