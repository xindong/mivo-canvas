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

## 如何在 P1-c 用它做 BFF diff 测试(SC1.2 执行入口)

两件套:

1. **静态套件**(`npm run test:unit` 默认跑,`server/contracts/contract.test.ts`):验证每个 `__captures__/` 快照满足其 invariant(锁定 status + 关键 body 字段),且每个契约 JSON 的 `capture`/`captures` 引用都能解析到文件。快、无服务。
2. **live diff**(`npm run contract:diff`,`scripts/contract-diff.mjs`):对 target 重发每个场景的请求,逐字段比对 live 响应与 `__captures__/` 基线,输出 `diff=0 / DIFFERS / INTENDED` 报告。target 参数化(dev middleware 或 BFF url),`--group` 可按组过滤。**这是 SC1.2 的执行入口,生成组/资产组 worker 也在用,保持向后兼容。**

### contract:diff 用法

```bash
# 对 dev middleware 跑全量(基线自证,应全 diff=0)
npm run contract:diff -- --target=dev

# 对 BFF 跑全量
npm run contract:diff -- --target=http://127.0.0.1:8080

# 对 BFF 只跑某一组(P1-c 各组 PR 各自验证自己那组)
npm run contract:diff -- --target=http://127.0.0.1:8080 --group=debug-logs
# 等价: MIVO_CONTRACT_TARGET_URL=http://127.0.0.1:8080 npm run contract:diff -- --group=debug-logs
```

退出码:0 = 无意外 diff;1 = 有意外 diff;2 = 运行错误。

### P1-c 工作流(以 debug-logs 组为例)

```bash
# 1. 起 BFF(本地模式,只听 127.0.0.1;配 debug view token 与基线一致)
MIVO_DEBUG_VIEW_TOKEN=test-token MIVO_DEBUG_LOG_DIR=/tmp/mivo-logs \
  MIVO_PORT=8080 npm run start:server &

# 2. 对 BFF 跑 debug-logs 组 diff
npm run contract:diff -- --target=http://127.0.0.1:8080 --group=debug-logs
# 期望: 7 match + 1 intended (D1: clean 413 vs dev ECONNRESET), 0 unexpected

# 3. 对 dev 跑全量(基线自证)
npm run contract:diff -- --target=dev
# 期望: 33 match, 0 unexpected
```

全绿 = BFF 对锁定字段的响应与 dev middleware 基线 diff=0(有意变更除外)。

### "有意变更"如何处理

契约 JSON 里 `discrepancy` 字段标出的项,是 dev middleware 当前行为与计划 §6.1 不符、或 BFF 应主动改的点。`contract-diff.mjs` 的 `INTENDED` 表登记每个有意变更的 BFF 期望(如 D1: `debug-logs-post-413` 期望 `status:413`),运行时:
- **保持 dev 行为**的项 → 必须 `diff=0`。
- **有意变更**的项 → live 命中 `INTENDED` 期望 → 标 `~ INTENDED Dx`(算通过);未命中 → `✗ UNEXPECTED`(有意变更没实现对)。SC1.2 要求"有意变更单独列表且各有测试"——`INTENDED` 表 + 各组 route 测试即是。

当前 `INTENDED` 表(随各组 PR 扩充):
| 场景 | ID | 说明 | BFF 期望 |
|------|----|------|---------|
| generate-413 | D1 | 干净 413 vs dev ECONNRESET | status=413, body={error:'Request body is too large'} |
| edit-413 | D1 | 干净 413 vs dev ECONNRESET | status=413, body={error:'Request body is too large'} |
| debug-logs-post-413 | D1 | 干净 413 vs dev ECONNRESET | status=413, body={ok:false,error:'Request body is too large'} |
| local-assets-file-403-traversal | D3 | frameworkDiff: `@hono/node-server` 强制补 `text/plain; charset=UTF-8` | 仅 `content-type` 与基线不同 |
| local-assets-file-404 | D3 | frameworkDiff: `@hono/node-server` 强制补 `text/plain; charset=UTF-8` | 仅 `content-type` 与基线不同 |
| eagle-folders-502 | D4 | frameworkDiff: `@hono/node-server` 强制补 `text/plain; charset=UTF-8` | 仅 `content-type` 与基线不同 |
| eagle-tags-502 | D4 | frameworkDiff: `@hono/node-server` 强制补 `text/plain; charset=UTF-8` | 仅 `content-type` 与基线不同 |
| eagle-assets-502 | D4 | frameworkDiff: `@hono/node-server` 强制补 `text/plain; charset=UTF-8` | 仅 `content-type` 与基线不同 |
| eagle-assets-file-404 | D4 | frameworkDiff: `@hono/node-server` 强制补 `text/plain; charset=UTF-8` | 仅 `content-type` 与基线不同 |

## 重新采集快照

`__captures__/` 由 `scripts/capture-contracts.mjs` 生成(一次性 regenerator,不进 `test:unit`):

```bash
node scripts/capture-contracts.mjs
```

它起一个临时 vite dev(无真实 key),只命中安全可触发的路径(405/400/413/403/越权/no-key 降级/Eagle 离线/占位),把响应写到 `__captures__/`。真实生成/LLM/平台链路不采,只 code-derived。

## debug 归一/脱敏/过滤

归一/脱敏/过滤纯函数(`normalizeRemoteDebugPayload` / `sanitizeRemoteDebugText` / `filterRemoteDebugRecords`)的实现已随 P1-c debug-logs 组迁到 `server/lib/debug-records.ts`,测试用例随迁到 `server/lib/debug-records.test.ts`(从 `vite.config.test.ts` 迁移,断言语义不变)。`vite.config.ts` 的 dev middleware 副本留到 P1-d 收尾删除;两边逻辑必须 1:1,不许漂移。见 `debug-logs.json` 的 `normalizationRefs`。

## 门禁

`npx tsc -b && npm run lint && npm run test:unit && npm run verify:logging` 全绿;P1-c 起追加 `npm run contract:diff`(对 dev 与 BFF 双跑,见上)。
- `server/` 由 `tsconfig.server.json` 纳入 `tsc -b`(`noEmit`,仅类型检查,Vite 不打包 `server/`)。`contract.test.ts` / `debug-records.test.ts` / `debug-logs.route.test.ts` 均被 tsc 检。
- live diff 默认不跑(独立 `npm run contract:diff`),不拖垮 `test:unit`。
