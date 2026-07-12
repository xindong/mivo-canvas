# DP-4:身份模型对齐(SSO 身份载体 == 权限层 userId 假设)

> 状态:**已核验 — 一致(2026-07-11,T1.4 动手前)**。
> 权威源:`docs/decisions/platform-architecture-2026-07-07.md` §13.5(归属模型)、`server/lib/owner.ts`、`server/lib/authz.ts`、`src/lib/authClient.ts`、`src/store/authSlice.ts`、PR #155(auth-sso)、`docs/decisions/soft-delete-semantics.md`(FX-7 share_link 恢复)。
> 触发:架构迁移执行计划 P1 T1.4 前置决策点 DP-4"身份模型对齐:T1.4 前确认 SSO 身份载体 == 权限层假设"。

## 1. 问题

T1.4 落地 owner/editor/viewer + 分享链接(project_members / share_links 两张表)。权限层按 `userId` 归属成员资格 / 分享归属。动手前必须确认:**SSO 网关给出的稳定身份载体(user id 形态、唯一性、跨会话稳定性)是否与权限层按 userId 归属的假设一致?**

- 一致 → 把核验结论写进本文件,继续实施。
- 不一致 / 含糊 → 立即报 lead 停手等拍板。

## 2. 证据链(逐行实测,非推断)

### 2.1 SSO 身份载体(gateway → client)

SSO 网关方案(feat/auth-sso,PR #155):身份由 nginx 网关 `auth.dsworks.cn` 提供 `/api/auth/me`,app 不做 OAuth。

**网关契约(实测,见 `server/lib/auth-stub.ts` / `server/routes/auth.ts` / `src/lib/authClient.ts` 注释)**:

```
未登录:401 {"detail":"Not authenticated"}
已登录:200 {"authenticated":true,"username":"zhuzan@xd.com","display_name":"朱赞",
            "is_admin":false,"services":[...,"mivo_canvas"],"avatar_url":null}
```

**字段映射(`src/lib/authClient.ts:51-58`)**:

```ts
if (body.authenticated && body.username) {
  return { authenticated: true, user: { id: body.username, name: body.display_name ?? body.username, avatar: body.avatar_url ?? null } }
}
```

→ **`AuthUser.id ← body.username`**。客户端身份载体 = SSO `username`(email-style,如 `zhuzan@xd.com`)。

**客户端缓存命名空间(FX-6,`src/store/authSlice.ts:55-73`)**:

```ts
const newUid = me.user.id              // = username
const prevUid = getPersistUserId()
// 非 logout 账号切换:prevUid !== newUid → 整页重载切换缓存命名空间
setPersistUserId(newUid)               // 缓存命名空间钉到 mivo-*:<username>
```

→ 客户端 IDB/localStorage key 全部以 `<username>` 分片(`mivo-canvas:<username>` / `mivo-chat:<username>` / `mivo-canvas-assets:<username>`)。

### 2.2 权限层 userId 假设

**platform §13.5(预检定稿 2026-07-08)**:

> 归属:`projects(id, ownerId)` + `project_members(projectId, userId, role)` + `share_links(token, projectId, permission)`;**人的标识一律用 maker user id,不发明第二套身份,零 maker 跨仓改动**。

→ 权限层 `userId` = maker user id。

**maker user id 的来源(§13.5 + `history/auth-probe/05-synthesis.md`)**:身份 A2 走 maker OAuth/JWT,网关 `/api/auth/me` 暴露的 `username` 即 maker user id(`zhuzan@xd.com`)。

**`server/lib/owner.ts` 注释(§13.5 目标)**:

> §13.5 目标 actor = 已认证 maker user id(网关 /api/auth/me.username)。SSO→project_members 层(T1.4)落地时,换本实现读网关注入的可信身份;wire 契约(信封/scope/revision-409/cascade)全不变,只改 resolveActor 内部。

→ 服务端权限层 `actor` 目标 = `username`(maker user id)。

### 2.3 一致性判定

| 维度 | SSO 载体(网关 → client) | 权限层假设(§13.5 + owner.ts) | 一致? |
|---|---|---|---|
| **形态** | `username`(email-style 字符串,`zhuzan@xd.com`) | maker user id = `username` | ✅ 同一字符串 |
| **唯一性** | SSO 账号全局唯一(email 域 + 本地段,网关保证) | `project_members.userId` 唯一标识一个 maker 账号 | ✅ |
| **跨会话稳定性** | 网关 session cookie `.dsworks.cn` 维持登录;`authSlice` 无 persist、每次 hydrate 读 `/me`,身份永远来自网关真相源 | `project_members.userId` 一次邀请永久有效(除非移除);不随会话变 | ✅ |
| **客户端可见** | `AuthUser.id = username`(client 知道自己的 id,可发起邀请) | 邀请体 `{userId: <被邀请人 username>}` | ✅ |
| **服务端可解析** | 网关注入可信身份(T1.4 实现见 §3) | `resolveActor` 切到读网关注入身份 | ✅(过渡,见 §3) |

**结论:一致。** SSO 给出的稳定身份载体(`username` = maker user id)与权限层按 `userId` 归属的假设完全一致:同一字符串、全局唯一、跨会话稳定、客户端可见、服务端经网关注入可解析。**无需发明第二套身份**(§13.5 明令),权限层 `project_members.userId` / `share_links`(无 userId,token 驱动)直接以 `username` 为键。

## 3. 过渡缺口(实现层,不阻塞,本 PR 解)

T1.3 的 `resolveActor` **当前**返回 `fingerprintOfPlatformKey(mivo_ 平台 key)` 的 sha256[:16] 指纹(`server/lib/owner.ts:31`),作为 T1.3 owner===actor 自归属的**过渡分片键**——**不是** SSO `username`。这是有意过渡:`owner.ts` 注释明示"T1.4 落地时换本实现读网关注入的可信身份,wire 契约全不变,只改 resolveActor 内部"。

**本 PR(T1.4)的 carrier 切换**:

`resolveActor` 改为优先读网关注入的可信身份 header `x-mivo-auth-user`(值为 SSO `username`),缺失时 fallback 到 mivo-key 指纹(T1.3 dev/legacy parity,保 #194 契约测试 + t1.3-wiring 烟测全绿):

```ts
// server/lib/owner.ts(T1.4)
export const SSO_TRUSTED_USER_HEADER = 'x-mivo-auth-user'

export const resolveActor = (c: Context): string => {
  const ssoUser = c.req.header(SSO_TRUSTED_USER_HEADER)?.trim()
  if (ssoUser) return ssoUser                 // T1.4 carrier = maker user id (username)
  return fingerprintOfPlatformKey(resolvePlatformCtx(c).platformKey)  // T1.3 fallback
}
```

**为什么保留指纹 fallback**:
1. **#194 契约测试不破**:`projects.route.test.ts` / `canvas.route.test.ts` / `userState.route.test.ts` / `t1.3-wiring.test.ts` 全部用 `X-Mivo-Api-Key` 驱动、不设 SSO header → 走指纹 fallback → owner===actor(fingerprint)自归属 + 跨 owner 404 语义不变。
2. **dev/legacy parity**:本地 dev 无网关、`MIVO_DEV_AUTH_STUB` 未开时,指纹 fallback 保 single-deployment env-key 配置不变。
3. **生产路径**:网关(nginx)认证后**总是**注入 `x-mivo-auth-user`(且必须 strip 客户端自带的同名 header,防伪造,见 §4),故生产 actor = `username`,权限层按 username 归属——与 §13.5 一致。

**载体一致性不因 fallback 受损**:fallback 仅是 dev/测试过渡;生产网关注入后 carrier = username = §13.5 maker user id,与本 §2 判定一致。

### 3.1 G2.2 换键迁移必须显式覆盖 legacy chat rows(DP-6R P1-3 要求)

G2.2(fingerprint→SSO username 换键)迁移 `persist_records.owner_id` 从指纹→username 时,**事务映射必须显式覆盖 legacy chat-message rows**,不得只迁 node/edge/anchor/canvas/project。

**理由(DP-6R per-actor 私有后)**:chat-message envelope.ownerId = **actor**(写入者本人),PK=(actor,'chat-message',msgId)。若换键只迁共享子资源(node/edge/anchor under canvas owner)而漏 chat-message:
- owner 的 actor key 从指纹变 username 后,owner_id 仍是旧指纹的 chat-message rows **不在新 actor key 名下** → owner GET /chat 读不到自己历史对话(数据孤儿);
- 成员侧无影响(per-actor 私有,成员本就只有自己的),但 owner 自身丢失历史 chat。

**事务映射要求(实现属 G2.2,本处只钉要求)**:
1. 同事务 `UPDATE persist_records SET owner_id=<username> WHERE owner_id=<fingerprint> AND type='chat-message'`(连同 node/edge/anchor/canvas/project/chat-collection 的 owner_id 同事务改);
2. `chat_order_revisions.actor_id` 同步改(migration 004 表,actor_id=actor;换键须覆盖,否则 owner 的 chat orderRevision cursor 留在旧 actor_id 下);
3. **fail-closed audit**(与 migration 003 注释一致,见 t1.6-cutover-runbook §G2.2):换键前断言所有 legacy chat-message.owner_id === 当时 canvas owner(即 owner 自己的指纹),异常行(成员名下不应有的 chat)no-go——不得静默 carry over,否则换键后归属错乱。
4. `idempotency_index.envelope_owner` 同步改(幂等 replay 指向新 owner)。

验收:换键后 owner GET /chat 仍见全部历史 chat;`chat_order_revisions` 按 username 查得;幂等 replay 不串。

## 4. 可信 header 契约(deployment 依赖,ops/lead 落地)+ 服务器侧防伪造

| 项 | 约定 |
|---|---|
| header 名 | `x-mivo-auth-user`(小写,Hono `c.req.header` 大小写不敏感) |
| 值 | SSO `username`(maker user id,如 `zhuzan@xd.com`),非 display_name |
| 注入方 | nginx 网关(auth.dsworks.cn)`auth_request` 通过后 `proxy_set_header X-Auth-User $remote_user`(或等价) |
| 信任边界 | BFF 仅在网关之后信任此 header;网关**必须**无条件覆盖(strip)客户端自带的 `X-Auth-User`,防身份伪造 |
| **opt-in 开关** | `MIVO_TRUST_SSO_HEADER=1` 才信任此 header(**默认关**;关 → fallback 指纹,防 BFF 被绕网关直连时伪造身份) |
| **网关共享密钥** | `MIVO_GATEWAY_SECRET`(生产必设):BFF 额外要求 `x-mivo-gateway-secret` header 匹配(网关注入,客户端不可构造)才信任 `x-mivo-auth-user`。密钥不匹配 → 不信任 SSO header(回退指纹,但**不冒充 victim**)。dev/test 不设 secret → 信任 header(本地无网关) |
| 缺失语义 | header 缺失 = 未经网关 或 未 opt-in → fallback 指纹(dev/legacy);**生产不得缺失**(缺失则权限层降级为指纹自归属,分享/邀请失效,见 §5 R-1) |
| 与 mivo key 正交 | `X-Mivo-Api-Key`(mivo_ 平台 key)仍管 platform ctx(图像生成 token 桶),与身份 header 正交;persist 路由 `rejectInvalidMivoApiKey` 边界保留(F4),但 owner 归属不再用指纹,改用 username |

**服务器侧防伪造(本 PR 实现,Greptile security 二轮修复)**:
1. **opt-in 开关**(`MIVO_TRUST_SSO_HEADER=1`,默认关):BFF 被绕网关直连时,攻击者发 `x-mivo-auth-user: victim` 也不被信任(flag 关 → 指纹 fallback,不冒充)。
2. **网关共享密钥**(`MIVO_GATEWAY_SECRET`):即便 opt-in 开,客户端仍可发同名 header 冒充;故配置密钥后 BFF 要求 `x-mivo-gateway-secret` 匹配(网关注入,客户端不可构造)才信任。攻击者不知密钥 → 无法冒充。
3. **启动配置校验**(`server/lib/owner.ts validateSsoConfig` + `server/index.ts` 启动告警):生产下 SSO 开但缺密钥 → 警告(可伪造);SSO 未开 → 警告(指纹共享风险)。防静默 misconfig(Greptile finding 2)。

> 注:具体 nginx 注入配置(header 名最终值、`auth_request` setup、共享密钥注入)是部署步骤,由 ops/lead 在生产网关落地;本 PR 实现 BFF 侧读取 + opt-in + 密钥校验 + 启动告警,不在本 PR 改 nginx 配置(无仓库可改)。

## 5. 未验证项 + 风险

| ID | 项 | 说明 |
|---|---|---|
| R-1 | **生产网关注入未验证** | `x-mivo-auth-user` + `x-mivo-gateway-secret` 的 nginx 注入未在本 PR 实测(无生产网关访问)。本 PR 已加服务器侧防伪造(opt-in + 共享密钥 + 启动告警);生产部署前 ops 仍须确认网关注入 + strip 客户端伪造 + 设 `MIVO_GATEWAY_SECRET`。缺失密钥则分享/邀请失效(降级指纹自归属)。 |
| R-2 | **username ↔ mivo key 指纹的映射(owner 键空间跃迁,G2.1 F1)** | T1.3 已建数据(ownerId=指纹,sha256[:16] hex)与 T1.4/G2.1 strict 新建数据(ownerId=username)在迁移窗口共存。**G2.2 owner 迁移** 是 strict 翻开的前置:把 ownerId 从指纹映射回 username(需原 mivo_ key 或预建映射表),跨三 backend 重键。G2.1 已加**机器判定**启动 gate(`server/lib/owner.ts` `assertStrictOwnerMigrationComplete` + persist backend `countLegacyFormOwners`):strict=1 且 legacy 形态 owner 行数>0 → 拒启动 exit 1(非文字约定);G2.2 迁移函数 `migrateLegacyOwnersToUsernameForm` 打桩(throw G2.2 scope)。受影响持久键全清单(owner inventory):persist_records.owner_id / projects.owner_id / canvases.owner_id / idempotency_index.owner_id(persist backend,gate 已覆盖 memory 实扫;PG detector 随 G2.2 落地);share_links.created_by(permission backend,G2.2 补 gate);AssetRecord.ownerFp + references[].ownerFp + .uploaders(asset store,G2.2 补 gate)。gate 覆盖面 + 迁移指引见 `docs/runbook/g21-strict-sso-runbook.md` §owner-migration gate + §owner inventory。 |
| R-5 | **指纹 fallback 残留共享身份风险** | 即便有共享密钥(opt-in),若攻击者绕网关直连(无密钥)→ fallback 指纹;若生产 `MIVO_PLATFORM_KEY` 共享/缺失,该指纹 actor 名下数据可被访问(Greptile finding 2 残留)。**完整修复**(SSO 模式下缺身份 → 401 拒绝而非 fallback)需改 `resolveActor` 返回 `string|null` + 全路由处理,本 PR 未做(改契约面大),列为 follow-up;本 PR 用启动告警让 misconfig 可见。生产纯 SSO(无指纹数据)下该残留不暴露数据。 |
| R-3 | **SSO username 变更(改名)罕见** | `username` 是 email-style 账号,改名极罕见;若发生,`project_members.userId` 旧值失效——按 §13.5 "零 maker 跨仓改动",username 变更属 maker 账号管理范畴,本层不处理(需 owner 重新邀请)。 |
| R-4 | **403 body 未进 shared 契约** | T1.4 引入成员越权 403(`{error:'forbidden'}`,server-local),**不**加进 `shared/persist-contract.ts` 的 `ApiErrorBody`(保 #194 契约不变,boundary 3)。非成员/无分享 → 404 unknown-* 与 #194 一致;成员越权(editor manage / viewer write)→ 403。客户端 PersistAdapter 当前仅以 owner 身份操作,不触发 403;editor/viewer UI 未建(boundary 4)。 |

## 6. 决议

- **DP-4 = 一致**。SSO 载体(`username` = maker user id)与权限层 `userId` 假设一致;T1.4 按 §13.5 以 username 为 `project_members.userId` 键、share_links 以 token 驱动(不绑 userId)。
- **carrier 切换**:`resolveActor` 切到读 `x-mivo-auth-user` 可信 header,保留指纹 fallback 保 #194 契约测试绿。
- **部署依赖 R-1** 报 lead,生产网关注入由 ops 落地(本 PR 不阻塞)。
- 本文件为 T1.4 实施的前置核验结论,落 `docs/decisions/`,供 T1.4 PR 引用。
