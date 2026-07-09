# Kernel 双轨契约（`?kernel=new|legacy`）

日期：2026-07-09
来源任务：T0.3 — 内核双轨藏身开关 + 契约（`--kernel` runner/CI 透传唯一出口是 T0.7 / PR #166；本 PR 只钉模式解析与契约，不实现 new 路径）
开关实现：`src/app/kernelMode.ts`

## 1. 背景与范围

内核迁移（legacy → 分层内核 + 四总线，CRDT-ready）要分多 PR 推进，每一步都可能 risky。
本契约建一个**藏身开关** `?kernel=new|legacy`，让迁移 PR 在默认 legacy（生产零感知）下合入，
new 路径藏在开关后逐步 flesh out，待契约测试全绿后一次性切默认。

与 `?renderer=dom|leafer|pixi`（`src/render/rendererMode.ts`，**view 层模块常量**）不同：
kernel 不止影响渲染，它影响 **store 初始化 / persist adapter / 缓存命名空间 / command 出口**——
任何一个错配都会导致 split-brain（双轨各自写、读对方没写的状态）或缓存污染。本契约把这四个
耦合点钉死，后续每个迁移 PR 都按此契约接缝。

**T0.3 本身只建开关与契约，不实现 new 路径。** 默认 legacy 下所有代码路径与 main 一致。

## 2. 开关 API

实现：`src/app/kernelMode.ts`（与 `rendererMode` 同构——模块加载时解析一次，页面生命周期内不变）。

| 符号 | 签名 | 用途 |
|---|---|---|
| `kernelMode` | `KernelMode`（`'new' \| 'legacy'`） | 一次性解析的内核身份，直接 import 读 |
| `getKernelMode()` | `() => KernelMode` | 可调用出口（T0.3 显式要求）；返回同一个解析结果，供 store 初始化等单点调用 |
| `isLegacyKernel` | `boolean` | 默认 true；"我是否在 legacy 轨"的快速判定 |
| `isNewKernel` | `boolean` | 默认 false；new 路径消费方用它分支 |

**解析优先级**：`VITE_MIVO_KERNEL`（构建期 env，最高）> `?kernel=`（URL）> 默认 `legacy`。
- env 用于 CI/构建期强制 kernel 而不污染 URL（e2e 矩阵、灰度构建）。
- URL 用于本地手切（`?kernel=new`）。
- 非法值 / 非浏览器环境（SSR/单测/Node）→ 回退默认 `legacy` 并 warn（非法值）或静默（非浏览器）。

**日志契约**（遵守 `docs/development-logging.md`，开关生效路径打 `debugLogger`）：
- 缺省 / 显式 legacy：一条 `debugLogger.log('Kernel', '...identity: legacy...')` 身份 log。
- `?kernel=new` / env=new：一条 `debugLogger.log('Kernel', 'new kernel requested（来源 ...）')`。
- 非法值：一条 `debugLogger.warn('Kernel', '未知 kernel mode...')`，**不**额外打身份 log（warn 即身份记录）。
- 非浏览器环境：不打 log（避免污染未 mock `debugLogger` 的测试，与 rendererMode 的 Greptile P2 同源）。

## 3. import order（导入顺序）

`kernelMode` 在模块加载时解析一次，**必须先于** 依赖它的 store/adapter/cache/command 模块被求值。
因此消费方导入顺序约束：

1. 先 `import { getKernelMode, isLegacyKernel } from '../app/kernelMode'`（或相对路径）。
2. 再 import 依赖 kernel 身份的模块：`store/*`、`lib/*persist*`、缓存 key 构造、command 出口。

**禁止循环依赖**：`kernelMode.ts` 只依赖 `store/debugLogStore`（写日志），不反向依赖任何 store/slice。
新路径实现时，new 内核的 store 初始化可以读 `getKernelMode()`，但 `kernelMode.ts` 不得 import 这些 store。

ESM 静态 import 图天然保证 `kernelMode` 在消费者模块体执行前完成解析；动态 `import()` 引入 new
内核实现时也必须在首帧渲染前完成（见 §6 command 出口的懒加载约定）。

## 4. shadow 读 / 单写策略（防 split-brain）

迁移任意时刻，**有且仅有一个 kernel 拥有 canonical 写入权**；另一个只读 shadow 用于比对。禁止双写。
canonical key 是 kernel 无关的唯一真相（见 §5），shadow 永远读 canonical，**禁止读自己 kernel 的空派生缓存**。

| 阶段 | canonical 写入方 | canonical 读取方 | new 派生缓存 | 状态 |
|---|---|---|---|---|
| A 默认 legacy（当前 T0.3） | legacy | legacy | 不存在 | `isNewKernel` 分支不得出现在生产代码 |
| B shadow 读 | legacy | legacy + new（new 从 legacy 的 canonical key 读，内存比对，不写） | 可选；仅热读缓存，绝不当真相 | new 实现接缝；契约测试比对 legacy 输出 |
| C 单写切换 | new（canonical version bump） | new + legacy（legacy 经 down-migrate 读 canonical） | new 可填热读缓存 | new 契约测试全绿后切；切前必须完成一次性 legacy→new checkpoint |
| D 删 legacy | new | new | 可删 | legacy 代码与开关一起删 |

### 4.1 B 阶段：new shadow 从哪里读

new shadow **必须从 legacy writer 的 canonical key 读**（`${BASE}:${userId}`，B 阶段即 legacy 格式），
在内存里跑 new 内核逻辑，把结果与 legacy 比对；不一致只走 `debugLogger.warn`，**不**回写到 UI / store / 服务端。
**禁止 new shadow 读自己的派生缓存 key（`${BASE}:${userId}:new`）当数据源**——那是空 namespace，
shadow 比对会得到假阴性/空数据，split-brain 即由此产生。

### 4.2 C 阶段：new 写后 legacy shadow 从哪里读

切轨 PR（B→C）必须含**一次性 legacy→new checkpoint**：把 canonical blob 从 legacy 格式迁移为 new 记录格式
（扁平化 / 三域拆分），`version` bump。此后 new 原生读 canonical。legacy 降为 shadow reader，经
**down-migrate**（zustand persist `migrate(persistedState, version)` hook，把 new 格式降级为 legacy 期望形态；
`canvasPersistConfig` 已有 migrate 机制，new 格式落地时扩展 down-migrate 分支）读同一 canonical，比对 new 输出。
**canonical key 全程不变**，分叉的是 blob 格式 + 版本号，由 migrate hook 桥接。

### 4.3 回退路径（C→legacy，写死：兼容读桥，禁止静默读旧 key）

灰度回退 `?kernel=legacy`（C 阶段已 new 写过 canonical 之后）时，**唯一合法回退路径 = 兼容读桥**：
legacy hydrate 读到 canonical（new 格式、version 已 bump）→ 经 `migrate` hook down-migrate 为 legacy 格式 →
legacy 看到 C 阶段 new 写入后的画布/聊天/资产引用变化，**无数据丢失**。legacy 随后的 persist 会以 legacy
格式覆写 canonical（version 降回），这是显式 in-place down-migration，不是“读旧 key”。

**硬禁止**：回退时**不得静默读 C 之前的旧 legacy key**（即把 canonical 当成没被 new 写过、跳过 down-migrate
直接按 legacy 格式读）——这会丢失 C 阶段全部写入，正是灰度回退一致性命门要堵的口子。
（显式 new→legacy in-place down-migration 可作为未来优化，但本契约钉死兼容读桥为唯一回退路径。）

### 4.4 切轨不变量

从 B→C（shadow→单写 new）是一次性 PR，配 full e2e `--kernel=both` + visual-diff + 性能 gate，不得与其它迁移步骤混提。

### 4.5 契约测试要求（本 PR 不写，阶段 B/C 实施 PR 必须补）

下列三场景必须由实施 new 路径的后续 PR（FX-6 / T1.2a / 阶段 B）补契约测试覆盖，本 PR 只在契约层钉死语义：
1. **B 阶段 new shadow 从哪里读**：new shadow 读 legacy canonical，断言不读空派生缓存、shadow 比对走内存。
2. **C 阶段 new 写后 legacy shadow 从哪里读**：new 写 canonical（version bump）后，legacy 经 down-migrate 读到 C 写入。
3. **灰度回退 `?kernel=legacy` 后如何处理 new 写入**：回退走兼容读桥（down-migrate），断言不静默读旧 key、C 阶段数据不丢。

**T0.3 落点**：阶段 A。`isNewKernel` 已导出但无生产消费方；任何迁移 PR 引入 new 路径必须从阶段 B shadow 读起步，不得直接进 C。

## 5. 缓存命名空间（canonical / 派生缓存 两层 key）

为防 split-brain，IDB / localStorage 的 key 分两层：**canonical 唯一真相 + kernel 派生缓存可丢弃**。

### 5.1 canonical source-of-truth key（kernel 无关，唯一真相）

- 格式：`${BASE}:${userId}`（FX-6 per-user 化前 = 现有扁平 key）。
- 用户数据的唯一真相源。**kernel 切换不改变 canonical key**——legacy 与 new 读写同一个 canonical，
  分叉的是 blob 格式 + `version`，由 persist `migrate` hook 桥接（见 §4.2/4.3）。
- 三个 canonical 面：canvas（`mivo-canvas-demo` → `mivo-canvas:${userId}`）/ chat（`mivo-chat-demo` →
  `mivo-chat:${userId}`）/ assets（`mivo-canvas-assets` IDB，blob 按 asset id 存，引用记录在 canonical canvas/chat 里）。

### 5.2 kernel 派生缓存 key（可丢弃，new 专属）

- 格式：`${BASE}:${userId}:${kernelMode}`，实际仅 new 填 `${BASE}:${userId}:new`（legacy 不用）。
- new kernel 专属的热读缓存（new 记录格式的派生投影，如 CRDT 预算结构）。
- **可丢弃**：丢失时从 canonical 重建。**绝不被任何 kernel 当作真相源读取**——new shadow 读 legacy
  canonical（§4.1），不读自己的派生缓存；canonical 才是真相。

### 5.3 与 FX-6 合成

FX-6（缓存 per-user 化）把扁平 key 升级为 `${BASE}:${userId}`；本契约把 `${BASE}:${userId}` 钉为 canonical、
`${BASE}:${userId}:new` 钉为 new 派生缓存。两者同 PR 落地；FX-6 是切默认 new 的硬前置
（账号切换不经 logout 会撞 canonical 命名空间）。

### 5.4 logout / 账号切换清理

清理 = 清当前 user 的 canonical + 当前 kernel 的派生缓存；不清另一轨的派生缓存（方便切回比对）。
logout 时 canonical 随账号回收，派生缓存一并清。**不得清另一 user 的 canonical**。

当前静态 key（待 FX-6 + 本契约一起改）：`mivo-canvas-demo` / `mivo-chat-demo` / `mivo-canvas-assets`。

## 6. command 出口

kernel 决定 command 走哪个出口：

- **legacy 出口**：现有 `canvasActionModel` dispatch（action 是 UI closure，含 File/Blob/AbortSignal，不可序列化）。
- **new 出口**：`CanvasCommand` JSON union（T2.3 新增，序列化、可发服务端、CRDT 可映射）。UI intent 层
  （closure 可留）与 effect 层（command）分离。

约定：
- `isLegacyKernel` → 走 legacy 出口；`isNewKernel` → 走 new 出口。**同一时刻一个 kernel 一个出口**。
- new 出口的实现用动态 `import()` 懒加载，避免 legacy 默认 bundle 膨胀；懒加载必须在首帧渲染前 settle
  （command 调度是同步路径，不能等 chunk）。
- T0.3 不接出口；T2.3 实施 `CanvasCommand` union 时按此契约接线。

## 7. e2e 参数透传 `--kernel=new|legacy|both`

镜像 `--renderer` 的约定（`scripts/e2e-runner.mjs`）：

- `parseKernel(argv)`：接受 `new` / `legacy` / `both`；非法值报错。支持 `--kernel X` 与 `--kernel=X` 两种写法。
- `--kernel=both` → 每个场景跑两遍（先 legacy 后 new），断言数不减。
- 透传给 smoke 脚本：dev 拓扑通过页面 URL `?kernel=` 注入；prod 拓扑通过构建期 `VITE_MIVO_KERNEL`
  注入（prod 是静态产物，URL 注入仍可，但 env 注入保证不依赖 URL rewrite）。
- `--kernel=new` 与 `--renderer=both` 正交组合：e2e 矩阵按 `(renderer, kernel)` 笛卡尔积跑（T0.7 CI 门禁）。

**T0.3 落点**：本 PR 不改 `e2e-runner.mjs`（只建开关 + 模式解析 + 契约 + 单测）。`--kernel` 的 runner/CI
透传**唯一出口是 T0.7（PR #166）**；本 PR 只钉模式解析与契约接缝，e2e 透传不在本 PR 落地。在此之前，
单测已覆盖 URL/env/默认三情形分流，e2e 透传接缝已在此契约钉死，T0.7 按本节约定接线。

## 8. 默认 legacy 生产无感约束（硬约束）

- 默认（无参数 / 无 env）必须解析为 `legacy`。
- `legacy` 下所有代码路径与 `main` 一致：`isNewKernel` 不被生产代码消费、new 路径未实现、缓存命名空间
  不变、command 出口不变。本 PR 的 diff 应只有新增文件（`kernelMode.ts` / `kernelMode.test.ts` / 本契约），
  不改任何现有行为。
- 切默认到 `new` 是独立 PR，必须前置：FX-6（缓存 per-user 化）+ T1.2a（record schema）+ 阶段 B shadow
  读契约测试全绿。FX-6 是硬前置（账号切换不经 logout 会撞缓存命名空间）。

## 9. 验收

- [x] `src/app/kernelMode.ts`：`getKernelMode(): 'new'|'legacy'`，默认 legacy，URL `?kernel=` + env
      `VITE_MIVO_KERNEL` 覆盖，优先级 env > URL > 默认。
- [x] 单测 `src/app/kernelMode.test.ts`：URL / env / 默认 三情形分流 + 非法值 / 非浏览器 / env>URL 优先级。
- [x] 开关生效路径打 `debugLogger`（身份 log / new 通道 log / 非法 warn），遵守 `docs/development-logging.md`。
- [x] 默认 legacy 下行为与 main 一致（本 PR 纯新增，零现有代码改动）。
- [x] `npm run lint` + `npx tsc -b --noEmit` + `npm run test:unit` 全绿。
- [ ] e2e `--kernel=` 透传与 CI 门禁（T0.7 / PR #166 唯一出口，本 PR 只钉模式解析 + 契约接缝）。
