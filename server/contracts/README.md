# server/contracts — dev middleware contract baseline (P1-b)

> 路线图 §6.2 P1-b 产物。基线 = `vite.config.ts` dev middleware(origin/main `22e2e4c`)。
> 用途:为 P1-c 端点平移与 SC1.2(BFF 与基线逐字段 diff=0)提供真相源。

## 这是什么

`vite.config.ts` 的 `localAssetLibraryPlugin`(L1405-L1614)把全部 `/api/mivo/*` 后端逻辑实现在 dev middleware 里——`vite build` 产物中这些端点不存在。P1 要把它们平移到独立 BFF(`server/`)。本目录在平移**之前**把每端点的响应契约录成基线,使 P1-c 的 BFF 可以对照基线做逐字段 diff,保证"平移不改行为"。

## 目录结构

```
server/contracts/
├── README.md                 # 本文件
├── index.md                  # 端点×场景覆盖矩阵(快查)
├── env-matrix.md             # BFF 启动契约:环境变量矩阵
├── generate.json             # /api/mivo/generate 契约
├── edit.json                 # /api/mivo/edit 契约
├── enhance.json              # /api/mivo/enhance 契约
├── debug-logs.json           # /api/mivo/debug-logs 契约
├── local-assets.json         # /api/mivo/local-assets(+文件) 契约
├── eagle.json                # /api/mivo/eagle/* 契约
├── pinterest-status.json     # /api/mivo/pinterest/status 契约
├── platform-helpers.json     # 平台通道 helpers(内部,非路由)契约
├── contract.test.ts          # vitest 契约测试骨架(静态 + live)
└── __captures__/             # live-captured 响应快照(33 个,提交入库)
```

## 来源标注约定(双轨)

每个场景标注 `source`:

| 标注 | 含义 | 可信度 |
|------|------|--------|
| `code-derived` | 从 `vite.config.ts` 源码推导(附 `sourceRef` 行号) | 静态正确,未实测 |
| `live-capturable` | 起 vite dev(无真实上游 key)实测可安全触发的路径;响应快照在 `__captures__/` | 实测证据 |

**不可安全实测的**(真实生成链路 / 真实平台 / 真实 LLM / 240s 超时)只 `code-derived`,附行号。`live-capturable` 场景都附 `capture: "__captures__/<name>.json"`(或 `captures: [...]`)指向提交的快照。

## 如何在 P1-c 用它做 BFF diff 测试

`contract.test.ts` 是 SC1.2 骨架。两个套件:

1. **静态套件**(默认 `npm run test:unit` 跑):验证每个 `__captures__/` 快照满足其 invariant(锁定 status + 关键 body 字段),且每个契约 JSON 的 `capture`/`captures` 引用都能解析到文件。快、无服务。
2. **live 套件**(仅 `MIVO_CONTRACT_LIVE=1` 跑):对 target 重发请求,断言 live 响应满足同一 invariant。target 由 `MIVO_CONTRACT_TARGET_URL` 指定,缺省起一个临时 vite dev server。

P1-c 工作流:
```bash
# 1. BFF 起在本机 3000 端口
MIVO_BFF_TOKEN=... node dist/server/main.js  # (示意,P1-e 落地后)

# 2. 把 target 指向 BFF,跑 live 套件
MIVO_CONTRACT_TARGET_URL=http://127.0.0.1:3000 \
MIVO_CONTRACT_LIVE=1 \
npm run test:unit -- server/contracts/contract.test.ts
```
全绿 = BFF 对锁定字段的响应与 dev middleware 基线 diff=0。

### "有意变更"如何处理

契约 JSON 里 `discrepancy` 字段标出的项,是 dev middleware 当前行为与计划 §6.1 不符、或 BFF 应主动改的点(例如:413 应发干净响应而非 ECONNRESET、Eagle 应补超时、local-assets 403 应补 Content-Type、各端点应补 405)。P1-c 平移时:
- **保持 dev 行为**的项 → 必须通过 live 套件 diff=0。
- **有意变更**的项 → 在 BFF 改完后,在契约 JSON 里把 `source` 升级并更新 `__captures__/`(或新建 `__captures-bff/`),在 PR 描述单列"有意变更清单 + 各自测试"。SC1.2 要求"有意变更单独列表且各有测试"。

## 重新采集快照

`__captures__/` 由 `scripts/capture-contracts.mjs` 生成(一次性 regenerator,不进 `test:unit`):

```bash
node scripts/capture-contracts.mjs
```

它起一个临时 vite dev(无真实 key),只命中安全可触发的路径(405/400/413/403/越权/no-key 降级/Eagle 离线/占位),把响应写到 `__captures__/`。真实生成/LLM/平台链路不采,只 code-derived。

## debug 归一/脱敏/过滤

`vite.config.test.ts` 的 `remote debug server helpers` 用例(`normalizeRemoteDebugPayload` / `sanitizeRemoteDebugText` / `filterRemoteDebugRecords`)是这些行为的**权威证据**。本基线**引用不复制**——见 `debug-logs.json` 的 `normalizationRefs`。P1-c BFF 必须保持这些纯函数行为不变;现有 vitest 用例继续作为 canonical proof。

## 门禁

`npx tsc -b && npm run lint && npm run test:unit && npm run verify:logging` 全绿。
- `contract.test.ts` 不在 `tsconfig.node.json` include 内(与 `vite.config.test.ts` 同惯例),`tsc -b` 不检查它;vitest 跑、eslint lint。
- live 套件默认 skip,不拖垮 `test:unit`。
