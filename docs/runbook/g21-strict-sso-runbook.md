# G2.1 严格 SSO cutover runbook

> 状态:**返修 v2(2026-07-12,双审 REQUIRES_CHANGES 6 finding 修复后)**。
> 权威源:`server/lib/owner.ts`(开关语义 + gate)、`server/persist/backend.ts`(`countLegacyFormOwners`)、`server/index.ts`(启动 gate wiring)、`server/app.ts`(route 挂载 + onError boundary)、`REVIEW-FINDINGS-G21.md`(双审 finding 全文)。
> 关联决策:`docs/decisions/dp4-identity-alignment.md` R-2(owner 键空间跃迁)、`docs/decisions/platform-architecture-2026-07-07.md` §13.5(归属模型)。

## 0. 开关总览(默认关,生产零变化)

| env | 默认 | 语义 |
|---|---|---|
| `MIVO_SSO_STRICT` | 未设(关) | `1` = 严格模式:persist 路由缺/错 gateway proof → 401,**不回退指纹**。 |
| `MIVO_GATEWAY_SECRET` | 未设 | 网关注入的共享密钥;strict 生产必设。未设 → strict 下所有 persist 请求 401(fail-closed)。 |
| `MIVO_DEV_MODE` | 未设 | 严格模式下本地开发通道;**三重保险**(opt-in + `MIVO_PUBLIC=1` 恒 false + `NODE_ENV` 正向枚举仅 `development`/`test`)。 |
| `MIVO_TRUST_SSO_HEADER` | 未设(关) | legacy(non-strict)opt-in:才信任 `x-mivo-auth-user` header。 |

**生产翻 strict 顺序**:`G2.2 owner 迁移完成` → `本 runbook §真实网关验收四项` → ops 设 `MIVO_GATEWAY_SECRET` + 网关注入 `x-mivo-gateway-secret` → 翻 `MIVO_SSO_STRICT=1`。**严禁先翻 strict**。

---

## 1. owner-migration gate(F1,机器判定,非文字约定)

### 1.1 机制

`server/lib/owner.ts#assertStrictOwnerMigrationComplete(env, backend)` —— 启动期(`server/index.ts` `await sharedPersistBackend.ready` 之后、`serve` 之前)调用:

- **非 strict** → no-op(生产零变化,现有行为完全不变)。
- **strict + backend 未实现 `countLegacyFormOwners`**(如 PG,G2.2 前未补)→ **fail-closed 拒启动**(无法机械判定迁移完成前不得翻 strict)。memory backend 已实现,可测。
- **strict + backend 实现 + legacy 形态 owner 行数 > 0** → **拒启动 exit 1**(报具体计数 + 迁移指引)。
- **strict + backend 实现 + 0 legacy 行** → 通过(迁移完成或无存量)。

### 1.2 legacy 形态判定

legacy owner 形态 = mivo-key 指纹(`sha256[:16]` hex,见 `server/lib/keys.ts#fingerprintOfPlatformKey`)。正则 `/^[0-9a-f]{16}$/`(`server/lib/owner.ts#LEGACY_FINGERPRINT_REGEX` / `isLegacyFormOwner`、`server/persist/backend.ts` 内联 `isLegacyFormOwnerId`)。SSO username 为 email-style(含 `@`,如 `zhuzan@xd.com`);`DEV_ACTOR_ID`=`mivo-dev-actor` —— 均不匹配,故可机械区分。

### 1.3 G2.2 迁移函数(打桩 seam)

`server/lib/owner.ts#migrateLegacyOwnersToUsernameForm(backend, resolveFingerprintToUsername)` —— **G2.1 不实装**(G2.2 scope),抛 `not implemented (G2.2 scope)`。具名 seam 供 gate 测试打桩 + G2.2 固定调用点。真实 G2.2 实现需 fingerprint→username 映射(需原 `mivo_` key 或预建映射表)+ 跨三 backend 重键 owner。

### 1.4 gate 测试(打桩迁移)

`server/routes/sso-strict.route.test.ts` §F1:
- seed legacy 形态 owner(指纹 ownerId)→ strict gate → 期望抛错(拒启动);
- 模拟迁移(re-seed 为 username 形态)→ strict gate → 通过;
- 非 strict + legacy 数据 → no-op 通过;
- strict + backend 无 `countLegacyFormOwners`(模拟 stub backend)→ fail-closed 抛错。

---

## 2. owner inventory(受影响持久键全清单)

strict 切换让 `resolveActor` 返回 SSO username(无指纹回退),下列键的 ownerId 为指纹形态的存量数据会对 SSO 用户不可见。G2.2 迁移须跨三 backend 重键:

| backend | 持久键 | G2.1 gate 覆盖? |
|---|---|---|
| persist(`PersistBackend`) | `persist_records.owner_id`(projects/canvas/userState/chat-collection/children) | ✅ memory 实扫(`countLegacyFormOwners` 扫 `byOwner` 外层 key) |
| persist(`PersistBackend`) | `idempotency_index.owner_id` | ✅ 随 persist 数据一致(idem key 含 ownerId;byOwner 扫描覆盖其所属 owner) |
| persist(`PersistBackend`) | `projects.owner_id` / `canvases.owner_id` | ✅ 同上(均在 byOwner 内,ownerId 即外层 key) |
| permissions(`PermissionBackend`) | `share_links.created_by` | ⏳ G2.2 补 gate(本 PR persist gate 已拒启动,permissions 存量 gate 随 G2.2 迁移一起补) |
| asset(`AssetStore`) | `AssetRecord.ownerFp` + `references[].ownerFp` + `.uploaders` | ⏳ G2.2 补 gate(同上) |

> **覆盖面说明**:G2.1 gate 真实覆盖 persist backend(主 owner-scoped 数据存储,memory 实扫可测);permissions + assets 的 gate 随 G2.2 迁移落地。strict 翻开前 persist gate 已机械拦截(legacy 指纹数据>0 → 拒启动),permissions/assets 的存量 gate 补齐前,strict 不会翻(ops 按 §0 顺序先跑 G2.2)。

---

## 3. 真实网关集成验收清单(F3,翻 strict 硬前置)

> ⏳ **待 lead 生产实测**(本仓无生产网关访问,以下为部署假设;**翻 strict 前必须由 lead/ops 在生产网关完成实测并签字**)。

进程内模拟测试(`sso-strict.route.test.ts` ①~④)已验证 BFF 侧四边界逻辑,但**非真实网关实测**——服务端无法区分"client 伪造 header"与"网关注入 header",且网关 strip client 同名 header、BFF 端口网络隔离均为部署依赖,无代码层证据。翻 strict 前必须补齐:

1. **client 伪造两 header 被剥离**:client 携带自造 `x-mivo-auth-user` + `x-mivo-gateway-secret` 直连 BFF → 被网关 strip(client 不知真实 `MIVO_GATEWAY_SECRET`)→ BFF 收到的 header 仅来自网关注入。验收:抓包确认 client 自带 header 不达 BFF。
2. **已登录注入真实 username**:SSO 登录后,网关 `auth_request` 通过 → 注入 `x-mivo-auth-user: <真实 username>` + `x-mivo-gateway-secret: <真实 secret>` → BFF `resolveActor` 返回 username → persist 数据按 username 归属可见。验收:登录用户列 projects 非空(若已有数据)。
3. **绕网关被挡**:client 不经网关直连 BFF 端口 → 无 `x-mivo-gateway-secret` → strict 下 401。验收:直连 BFF IP:port 持任意 header → 401。
4. **BFF 非网关网络不可达**:BFF 端口仅网关可达(网络隔离 / bind 127.0.0.1 + 网关反代 / iptables)。验收:非网关机直连 BFF 端口连接被拒(不是 401,是网络层不可达)。

> 注:nginx 注入配置(header 名最终值、`auth_request` setup、共享密钥注入、strip client header)是部署步骤,由 ops/lead 在生产网关落地;本仓无 nginx 配置可改。本 PR 实现 BFF 侧读取 + opt-in + 密钥校验 + 启动告警 + 启动 gate。

---

## 4. 静态共享 secret 信任根评估(F3/F4)

### 4.1 现状

`MIVO_GATEWAY_SECRET` 是**静态对称共享密钥**:网关与 BFF 共享同一 secret,网关注入 `x-mivo-gateway-secret` header,BFF 用 `ssoHeaderSecretOk` 校验(F4 返修:两侧 SHA-256 digest + `crypto.timingSafeEqual`,恒时,无长度/前缀泄漏)。

### 4.2 信任根评估

**可接受前提**(满足全部则静态 secret 可作 internal-boundary proof):
- 网关与 BFF 在同一可信网络(BFF 不对公网直暴露,见 §3.4);
- secret ≥32 字节高熵、定期轮换、不入日志/错误响应/git;
- 网关 strip client 自带同名 header(§3.1),即 secret 不被 client 观察到。

**不满足时的残留风险**:若 BFF 被绕网关直连(网络隔离失效),攻击者不知 secret → strict 下 401(已 fail-closed);但若 secret 泄漏(日志/配置库),攻击者可伪造 `x-mivo-gateway-secret` + 任意 `x-mivo-auth-user` 冒充任意 owner。

### 4.3 后续项(G2.1b,不在本单实现)

若静态 secret 信任根不可接受,升级为:
- **mTLS**:网关↔BFF 双向 TLS,证书作为身份证明(替代共享 secret);
- **时效签名**:网关用短期私钥签发带 timestamp 的 token(BFF 验签 + 时效窗口),替代静态 secret。

列为 **G2.1b follow-up**(本 PR 不实现;评估结论:当前静态 secret 在 §4.2 前提下可接受作 cutover 起步,G2.1b 视威胁模型演进升级)。

---

## 5. route security matrix(F6)

strict 模式下每条 stateful route 的鉴权域 + 测试引用:

| route | 鉴权域 | strict 下行为 | 测试 |
|---|---|---|---|
| `GET/POST /api/projects` | owner-scoped(`resolveActor`) | 翻 strict 后走 SSO actor;缺 proof → 401 | `sso-strict.route.test.ts` ①②③④⑤ |
| `GET/PATCH/DELETE /api/projects/:id/canvases` | owner-scoped(`resolveActor`) | 同上 | `sso-strict.route.test.ts`(projects 路由驱动) |
| `GET/POST/PATCH/DELETE /api/canvas/:id/...` | owner-scoped(`resolveActor`) | 同上 | `canvas.route.test.ts` + sso-strict |
| `GET/PUT /api/user-state` | owner-scoped(`resolveActor`) | 同上 | `userState.route.test.ts` |
| `POST /api/mivo/tasks/:id` / `GET /tasks/:id` | owner-scoped(`resolveTaskOwner`→`resolveActor` strict) | strict 走 SSO actor;缺 proof → 401 | `sso-strict.route.test.ts` §tasks |
| `POST /api/assets` / `GET /api/assets/:id` | owner-scoped(`resolveAssetOwner`→`resolveActor` strict) | strict 走 SSO actor;缺 proof → 401 | `sso-strict.route.test.ts` §assets |
| `* /api/projects/:id/members` | owner-scoped(`resolveActor` + authz) | 同 projects | `permissions.route.test.ts` |
| `* /api/projects/:id/share-links` | owner-scoped(`resolveActor` + authz) | 同 projects | `permissions.route.test.ts` |
| `GET /api/share/:token` | **token-scoped**(无鉴权,token 驱动) | strict 不影响(revoked→410,unknown→404) | `permissions.route.test.ts` |
| `POST /api/mivo/debug-logs` | **system-scoped**(独立防护,见 §5.1) | strict **不门控**(非 owner-scoped);独立防护生效 | `debug-logs.route.test.ts` §G2.1 strict |
| `GET /api/mivo/debug-logs` | **system-scoped**(`MIVO_DEBUG_VIEW_TOKEN`,public fail-closed) | strict 不影响 | `debug-logs.route.test.ts` D8 |
| `POST /api/mivo/generate\|edit\|enhance` | stateless(无 resolveActor) | strict 不影响(不持久化) | — |
| `GET /api/keys` / `/api/auth/me` | stateless / 网关提供 | strict 不影响 | — |

### 5.1 debug-logs 为何是 system-scoped 而非 owner-scoped(F6 选型)

`POST /api/mivo/debug-logs` 持久写 JSONL,但选 **system-scoped + 独立防护**(非走 `resolveActor` gateway proof),理由:
- debug-logs POST 由**客户端浏览器**直接调用(client-side `debugLogger` 上报诊断日志);浏览器不持有 `MIVO_GATEWAY_SECRET`(仅网关注入),若要求 gateway proof 会断本地 dev + 绕网关环境的客户端上报;
- debug-logs 是**诊断遥测**(system-scoped),非 owner-scoped 用户数据;归属无意义,按系统级采集;
- 独立防护已具备(D7 origin allowlist + 每 IP rate limit + 1MB body cap + D8 GET token/public fail-closed),strict 下继续生效(见 `debug-logs.route.test.ts` §G2.1 strict)。

`server/app.ts` 注释已修正(原"Covers all /api persistence routes"漏列 debug-logs):明确 owner-scoped persist 路由走 SSO actor;debug-logs 为 system-scoped telemetry,独立防护,不经 `ssoAuthBoundary`。

### 5.2 onError boundary 覆盖

`app.onError(ssoAuthErrorHandler)`(顶层)捕获 sub-app 内 `resolveActor`/`resolveTaskOwner`/`resolveAssetOwner` 抛出的 `SsoAuthError` → 401。F5 返修:`ssoAuthErrorHandler` 非 `SsoAuthError` 分支精确复刻 Hono 默认(`HTTPException.getResponse` + `console.error` + 500 文本),不吞普通错误。

---

## 6. 翻 strict 硬前置清单(汇总)

翻 `MIVO_SSO_STRICT=1` 前必须全部满足:

- [ ] **G2.2 owner 迁移完成**:跨三 backend(persist/permissions/assets)把指纹 ownerId 重映射为 username;启动 gate `assertStrictOwnerMigrationComplete` 通过(0 legacy 行)。〔本 PR gate 已机械判定,G2.2 落地迁移〕
- [ ] **PG backend `countLegacyFormOwners` 已实现**(若生产用 PG);否则 strict 启动 fail-closed 拒启动。〔G2.2 落地〕
- [ ] **真实网关四项验收**(§3)由 lead/ops 在生产网关实测签字:① client 伪造 header 被剥离 ② 已登录注入真实 username ③ 绕网关被挡 ④ BFF 非网关不可达。〔待 lead 生产实测〕
- [ ] **`MIVO_GATEWAY_SECRET` 已设**(≥32 字节高熵,已轮换,不入日志/git)。
- [ ] **静态 secret 信任根评估**(§4)已确认 §4.2 前提满足,或已立 G2.1b 升级项(mTLS/时效签名)。
- [ ] **route security matrix**(§5)每路由鉴权域已测试覆盖。

> 未满足前翻 strict → 启动 gate 拒启动(persist legacy 数据>0)或运行时 401(缺 gateway secret)。G2.2 未实装前,strict 不得翻开。
