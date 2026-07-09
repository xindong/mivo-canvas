# Kernel 双轨契约（`?kernel=new|legacy`）

日期：2026-07-09（修订：2026-07-10，二轮审查 r2 修复）
来源任务：T0.3 — 内核双轨藏身开关 + 契约（`--kernel` runner/CI 透传唯一出口是 T0.7 / PR #166；本 PR 只钉模式解析与契约，不实现 new 路径）
开关实现：`src/app/kernelMode.ts`

> **修订说明（2026-07-10 r2）**：原 §4.2/§4.3 把 C 阶段 legacy shadow 读与灰度回退都建在 zustand persist `migrate` 之上，声称"只读兼容桥、无数据丢失"。但 zustand v5 真实语义是：persisted version ≠ options.version 时调 `migrate()` 后**立即 `setItem()` 写回** options.version（`node_modules/zustand/middleware.js:392-425`），down-migrate 不是只读读桥。本轮按 lead 拍板重写：①C 稳态 legacy shadow 改 raw storage read + 纯函数 projection（禁 migrate 写回路径）；②灰度回退改 **checkpointed rollback 仪式**（先快照 ckpt，再放行 down-migrate 写回）+ 恢复仪式（up-migrate + 可重建元数据重算，ckpt 仅极端 forensic）；③新增迁移窗口硬约束（C 阶段 new-only 字段必须可从 legacy 重建）与 new-only 字段分类表；④新增 FX-6 hydration 顺序硬契约（persist name 必须在 auth resolved 后构造）。原"无数据丢失"声明收窄为"用户数据无损；new-only 元数据可重建"。

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

迁移任意时刻的**稳态**下，**有且仅有一个 kernel 拥有 canonical 写入权**；另一个只读 shadow 用于比对，禁止双写。**唯一例外是显式回退 transaction（§4.3）**：回退窗口内 legacy 经 down-migrate 写 canonical 是合法的，但前提是已先把 new canonical 快照到 ckpt（§4.3 仪式）、且 new-only 字段全部可从 legacy 重建（§4.5）。canonical key 是 kernel 无关的唯一真相（见 §5），shadow 永远读 canonical，**禁止读自己 kernel 的空派生缓存**。

| 阶段 | canonical 写入方 | canonical 读取方 | new 派生缓存 | 状态 |
|---|---|---|---|---|
| A 默认 legacy（当前 T0.3） | legacy | legacy | 不存在 | `isNewKernel` 分支不得出现在生产代码 |
| B shadow 读 | legacy | legacy + new（new 从 legacy 的 canonical key 读，内存比对，不写） | 可选；仅热读缓存，绝不当真相 | new 实现接缝；契约测试比对 legacy 输出 |
| C 单写切换 | new（canonical version bump） | new + legacy（legacy 经 raw read + projection 读 canonical，只读 shadow，禁 migrate 写回） | new 可填热读缓存 | new 契约测试全绿后切；切前必须完成一次性 legacy→new checkpoint |
| 回退（C→legacy） | legacy（显式 rollback transaction，down-migrate 写回） | legacy | ckpt 已写保险 | 必须先 ckpt 快照（§4.3）；new-only 字段可重建（§4.5） |
| D 删 legacy | new | new | 可删 | legacy 代码与开关一起删 |

### 4.1 B 阶段：new shadow 从哪里读

new shadow **必须从 legacy writer 的 canonical key 读**（`${BASE}:${userId}`，B 阶段即 legacy 格式），
在内存里跑 new 内核逻辑，把结果与 legacy 比对；不一致只走 `debugLogger.warn`，**不**回写到 UI / store / 服务端。
**禁止 new shadow 读自己的派生缓存 key（`${BASE}:${userId}:new`）当数据源**——那是空 namespace，
shadow 比对会得到假阴性/空数据，split-brain 即由此产生。

### 4.2 C 阶段：legacy shadow 从哪里读（只读 raw read + projection，禁用 zustand 写回路径）

切轨 PR（B→C）必须含**一次性 legacy→new checkpoint**：把 canonical blob 从 legacy 格式迁移为 new 记录格式
（扁平化 / 三域拆分），`version` bump。此后 new 原生读 canonical。legacy 降为 shadow reader，经
**raw storage read + 纯函数 projection** 读同一 canonical：直接读 IDB/localStorage 的 canonical blob
（new 格式、version 已 bump），用纯函数投影成 legacy 期望形态，在内存里与 new 输出比对；不一致只走
`debugLogger.warn`，**不**回写 UI / store / canonical。

**硬禁止**：legacy shadow **不得**调用 zustand persist 的 `rehydrate()` / `migrate()` 路径读 canonical。zustand v5
在 persisted version ≠ options.version 时会调 `migrate()` 并**立即 `setItem()` 写回** options.version
（`node_modules/zustand/middleware.js:392-425`；`canvasPersistConfig.ts` 的 `setItem()` 写
`{ state: partialize(get()), version: options.version }`），这会把 canonical 降回 legacy version、丢 new-only
字段——shadow 读一旦走 migrate 就不是只读，split-brain 即由此产生。`canvasPersistConfig` 的 `migrate` hook
仅供**显式 rollback transaction**（§4.3）使用，不得用于 C 稳态 shadow compare。

**canonical key 全程不变**，分叉的是 blob 格式 + 版本号；C 稳态 shadow 比对由 migrate 之外的只读 projection 桥接。

### 4.3 回退路径（C→legacy：checkpointed rollback 仪式，取代原"只读兼容桥"）

灰度回退 `?kernel=legacy`（C 阶段已 new 写过 canonical 之后）时，**不存在"只读兼容桥"**——zustand persist
`migrate` 一旦触发就会 `setItem()` 写回（证据见 §4.2 硬禁止段），任何声称 down-migrate 是只读读桥的设计都与
zustand 真实语义冲突。本契约因此把回退写成**显式 checkpointed rollback transaction**，仪式分两步：

**步骤 1 — 入口快照（ckpt 保险，只写不读，幂等）**：切回 legacy 前，先把当前 canonical(v-new) 一次性
快照到 `${BASE}:${userId}:ckpt-v<N>`（N = 当前 new canonical version）。**只写不读**——ckpt 是保险，回退
稳态不读它；**幂等**——若同 version 的 ckpt 已存在则不覆盖（防多次回退刷掉更早快照）。ckpt 写入必须先于
down-migrate 的任何 `setItem()`。

**步骤 2 — 放行 zustand 正常 down-migrate（顺框架行为，不逆）**：ckpt 落盘后，放行 zustand persist 的
`migrate(persistedState, version)` hook 把 new 格式降级为 legacy 期望形态，并接受其 `setItem()` 把 canonical
以 legacy 格式、legacy version 覆写。这是**显式 in-place down-migration transaction**，不是"读旧 key"，也不是
"只读桥"。legacy 期间正常读写 legacy 版 canonical。

**硬禁止**：回退时**不得静默读 C 之前的旧 legacy key**（即把 canonical 当成没被 new 写过、跳过 ckpt + down-migrate
直接按 legacy 格式读）——这会丢失 C 阶段全部写入，正是灰度回退一致性命门要堵的口子。

### 4.4 恢复路径（legacy→new：up-migrate + ckpt 逐字段恢复仪式）

切回 `?kernel=new` 时，恢复仪式分两路并按冲突规则合并：

**步骤 1 — up-migrate legacy 版 canonical（拿回退期编辑）**：把 legacy 版 canonical（含用户在回退期的全部
编辑）经 `migrate` hook up-migrate 为 new 格式，作为恢复后 canonical 的用户数据基线。

**步骤 2 — 按逐字段恢复表从 ckpt 恢复 new-only 元数据**：ckpt（§4.3 步骤 1 快照）里的 new-only 字段按
"逐字段恢复表"（§4.5）决定是否抄回。

**冲突规则（写死）**：
- **用户数据以 canonical（较新编辑）为准**——回退期用户在 legacy canonical 里的编辑一律保留，不从 ckpt
  抄回 ckpt 时点的旧值。
- **元数据可重建者一律重建，不从 ckpt 抄**——`revision` 重新初始化、CRDT clock 重置等可重建元数据由
  up-migrate 路径重算，不读 ckpt。
- **ckpt 仅用于极端 forensic**——仅当某 new-only 字段既不在 up-migrate 后的 canonical 里、又无法重建时，
  才从 ckpt 抄回；这是兜底，不是常态路径。

结果：canonical 拿到回退期编辑 + new-only 可重建元数据由 up-migrate 重算；ckpt 是只写不读的保险，常态恢复不依赖它。

### 4.5 迁移窗口硬约束（C 阶段 new-only 字段可重建性）

回退能"无损"的前提是：**C 阶段 new kernel 禁止引入"不可从 legacy 表示重建"的用户数据**。任何 new-only 字段
必须是**可重建元数据**——即从 legacy canonical（用户数据）经纯函数重算可得，不依赖 new-only 状态机。禁止引入
"只有 new canonical 才存、legacy 无法表达且无法重算"的用户数据字段。

**new-only 字段分类表**（契约层枚举，实施 PR 按此表逐字段对齐）：

| new-only 字段 | 分类 | 重建语义（从 legacy canonical 如何重算） |
|---|---|---|
| `revision`（文档版本号） | 可重建元数据 | up-migrate 时重新初始化为 legacy canonical 当前 revision；不从 ckpt 抄 |
| CRDT clock（逻辑时钟） | 可重建元数据 | up-migrate 时重置为 0 / legacy 基线；CRDT 接缝由 canonical 内容驱动 |
| 记忆接缝索引（memory seam index） | 可重建元数据 | 从 legacy canonical 的画布/聊天节点序列重算接缝；不依赖 new 专属状态 |
| 三域拆分元数据（canvas/chat/assets 域边界） | 可重建元数据 | 从扁平 legacy canonical 按域划分规则重新拆分；划分规则是纯函数 |
| 用户画布内容 / 聊天消息 / 资产引用 | **用户数据（非 new-only）** | 必须在 legacy canonical 可表达——这是 §4.3 down-migrate 不丢用户数据的根因 |
| 任何"仅 new 状态机持有、legacy 无法表达且无法重算"的字段 | **禁止引入** | C 阶段不得新增此类字段；若 PR 试图引入，CI 必须拒 |

**"无数据丢失"声明改写**：本契约不再声称笼统的"回退无数据丢失"。准确声明为——

> **用户数据无损**（画布/聊天/资产引用在 legacy canonical 可表达，down-migrate 不丢）**；new-only 元数据可重建**（重建语义按上表逐字段列明，up-migrate 重算、不从 ckpt 抄）。

ckpt（§4.3）是这一声明的兜底保险：常态恢复走 up-migrate + 可重建元数据重算；ckpt 仅极端 forensic 用。

### 4.6 切轨不变量

从 B→C（shadow→单写 new）是一次性 PR，配 full e2e `--kernel=both` + visual-diff + 性能 gate，不得与其它迁移步骤混提。

### 4.7 契约测试要求（本 PR 不写，阶段 B/C 实施 PR 必须补）

下列场景必须由实施 new 路径的后续 PR（FX-6 / T1.2a / 阶段 B/C）补契约测试覆盖，本 PR 只在契约层钉死语义：
1. **B 阶段 new shadow 从哪里读**：new shadow 读 legacy canonical，断言不读空派生缓存、shadow 比对走内存。
2. **C 阶段 legacy shadow 从哪里读**：new 写 canonical（version bump）后，legacy 经 raw read + projection 读到
   C 写入；**断言 legacy shadow 路径不调用 zustand persist 的 `setItem()`**（不触发自动写回）。
3. **灰度回退 `?kernel=legacy` 后如何处理 new 写入**：回退走 checkpointed rollback——先断言 ckpt 写入
   `${BASE}:${userId}:ckpt-v<N>` 且幂等（同 version 不覆盖）；再断言 down-migrate 写回 canonical 为 legacy version；
   断言不静默读旧 key。
4. **恢复 `?kernel=new` roundtrip**：`new → legacy → new` roundtrip，断言用户画布/聊天/资产引用（用户数据）
   无损；`revision`/CRDT clock/记忆接缝/三域拆分元数据按 §4.5 分类表重建（不从 ckpt 抄）；ckpt 仅极端 forensic 路径可读。

**T0.3 落点**：阶段 A。`isNewKernel` 已导出但无生产消费方；任何迁移 PR 引入 new 路径必须从阶段 B shadow 读起步，不得直接进 C。

## 5. 缓存命名空间（canonical / 派生缓存 两层 key）

为防 split-brain，IDB / localStorage 的 key 分两层：**canonical 唯一真相 + kernel 派生缓存可丢弃**。

### 5.1 canonical source-of-truth key（kernel 无关，唯一真相）

- 格式：`${BASE}:${userId}`（FX-6 per-user 化前 = 现有扁平 key）。
- 用户数据的唯一真相源。**kernel 切换不改变 canonical key**——legacy 与 new 读写同一个 canonical，分叉的是 blob
  格式 + `version`；C 稳态 shadow 由只读 projection 桥接（§4.2），显式回退由 checkpointed rollback + migrate
  桥接（§4.3/§4.4）。
- 三个 canonical 面：canvas（`mivo-canvas-demo` → `mivo-canvas:${userId}`）/ chat（`mivo-chat-demo` →
  `mivo-chat:${userId}`）/ assets（`mivo-canvas-assets` IDB，blob 按 asset id 存，引用记录在 canonical canvas/chat 里）。

### 5.2 kernel 派生缓存 key（可丢弃，new 专属）

- 格式：`${BASE}:${userId}:${kernelMode}`，实际仅 new 填 `${BASE}:${userId}:new`（legacy 不用）。
- new kernel 专属的热读缓存（new 记录格式的派生投影，如 CRDT 预算结构）。
- **可丢弃**：丢失时从 canonical 重建。**绝不被任何 kernel 当作真相源读取**——new shadow 读 legacy
  canonical（§4.1），不读自己的派生缓存；canonical 才是真相。

**ckpt key（回退保险，非热读缓存）**：`${BASE}:${userId}:ckpt-v<N>`（§4.3 步骤 1）。与 `${BASE}:${userId}:new`
不同：ckpt 只写不读（常态恢复不读它，§4.4 仅极端 forensic 才读）、不参与热读、不是 kernel 派生缓存；清理随
当前 user（§5.4），不随 kernel 切换清。

### 5.3 与 FX-6 合成

FX-6（缓存 per-user 化）把扁平 key 升级为 `${BASE}:${userId}`；本契约把 `${BASE}:${userId}` 钉为 canonical、
`${BASE}:${userId}:new` 钉为 new 派生缓存、`${BASE}:${userId}:ckpt-v<N>` 钉为回退保险。两者同 PR 落地；FX-6 是
切默认 new 的硬前置（账号切换不经 logout 会撞 canonical 命名空间；hydration 顺序见 §5.5）。

### 5.4 logout / 账号切换清理

清理 = 清当前 user 的 canonical + 当前 kernel 的派生缓存 + 当前 user 的 ckpt 保险；不清另一轨的派生缓存
（方便切回比对）。logout 时 canonical 随账号回收，派生缓存与 ckpt 一并清。**不得清另一 user 的 canonical**。

当前静态 key（待 FX-6 + 本契约一起改）：`mivo-canvas-demo` / `mivo-chat-demo` / `mivo-canvas-assets`。

### 5.5 FX-6 hydration 顺序硬契约（auth → persist name，P2）

FX-6 把 canonical key 升级为 `${BASE}:${userId}`（§5.1）后，persist name 含 userId，hydration 顺序必须钉死，否则
会出现"store 用旧/匿名 userId hydrate → auth 才解析到新 userId → persist 把 A 的画布写进 B 的 canonical"的反例。

**硬契约**：
1. **persist name 构造时序**：persist name（含 userId 的 canonical key）**必须在 auth hydrate resolved 之后
   构造**。`useStoreHydration` 必须等 auth 到达终态（`authenticated` / `unauthenticated`）后再 rehydrate
   canvas/chat；**禁止 fire-and-forget 并行**——当前 `src/main.tsx:33-36` auth hydrate 是 fire-and-forget、
   `src/app/useStoreHydration.ts:28-33` 并行 rehydrate 无 userId 依赖，**FX-6 实施 PR 必须改这两处**，把 auth
   barrier 前置。
2. **userId 变化 → reset + rehydrate**：登录 / 登出 / 切号导致 userId 变化时，先**停止旧 key 写入**、
   **reset in-memory store**（清当前 user 的内存态），再**rehydrate 新 user canonical**；不得在旧内存态上直接
   覆写新 user 数据。
3. **未登录态用 anonymous 命名空间，且不与登录态合并**：未登录态使用显式 `anonymous` / 只读 demo 命名空间
   （如 `mivo-canvas:anonymous`），**不得与真实 user canonical 混用**——anonymous 态的编辑不得写进任何登录
   user 的 canonical，登录后 anonymous 态不自动并入新 user。
4. **logout / 切号清理边界**（接 §5.4）：logout 清当前 user canonical + 当前 kernel 派生缓存 + ckpt；切号 =
   logout 旧 user + login 新 user 的组合，走 §5.4 清理 + 本节 reset/rehydrate。**不得清另一 user 的 canonical**。

**验收**：FX-6 实施 PR 必须有契约测试或 e2e 覆盖 A→B 账号切换、B→A 切回、logout 后登录 B，并在每个场景分别跑
`kernel=legacy`、`kernel=new`、C 后 `new → legacy → new`，断言 storage key、内存 scene/chat/asset references
全部属于当前 userId，且不会清理另一 user 的 canonical。

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
