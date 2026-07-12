# MivoCanvas BFF Deployment

> **鉴权真相(2026-07-08 SSO 网关方案)**:唯一用户认证边界 = 公司统一 SSO 网关
> `auth.dsworks.cn`(支持飞书登录,公司 SSO 标配,**不在本仓改动范围**)。BFF
> **无自身 app gate**,这是设计如此 —— 身份(`/api/auth/me`)由网关提供,未登录
> 请求被网关 302 跳登录页挡掉。BFF 部署在网关之后,**"不被绕过直连 BFF 端口"由
> ops / 网络层保证**(网关前置 + 网络隔离),**本仓代码层不处理**。

## 部署拓扑

```
用户浏览器 ──https──▶ 公司统一 SSO 网关(auth.dsworks.cn,飞书登录)
                          │ 未登录 → 302 跳登录页;已登录 → 转发到后端
                          ▼
                     后端 BFF(由 ops 部署在网关后)
                          │
                          ▼
                     /api/mivo/* /api/keys/* /api/auth/me(网关盖 /me)
```

- 网关(`auth.dsworks.cn`,nginx + 自研 Python 后端)负责:未登录 302 跳飞书登录、
  已登录后盖过 `/api/auth/me`(直接应答 200/401,不转 BFF)、转发其余路径到 BFF。
- BFF 无 app gate、不验身份 header、不做 OAuth —— 身份只经 `/api/auth/me` 读。
- "BFF 端口不对外直连"是 ops / 网络层的职责(网关前置 + 网络隔离),本仓不处理;
  若需在代码层加纵深防御(如验网关注入的身份 header),需 ops 确认网关契约后另议。

## Container

```bash
docker build -t mivocanvas-bff .
docker run --rm -p 8080:8080 \
  -e MIVO_PUBLIC=1 \
  -e NODE_ENV=production \
  -e MIVO_PUBLIC_ORIGIN=https://<canonical-host> \
  -e MIVO_IMAGE_API_KEY=replace-me \
  -e MIVO_LLM_API_KEY=replace-me \
  -e MIVO_PLATFORM_KEY=replace-me \
  -e MIVO_DEBUG_LOG_DIR=/var/lib/mivo/debug-logs \
  -v "$PWD/data/debug-logs:/var/lib/mivo/debug-logs" \
  mivocanvas-bff
```

> 不再有 `MIVO_BFF_TOKEN`(SSO 切换后 app 无 gate,旧 BFF token gate 已随飞书 OAuth
> 骨干删除)。`MIVO_PUBLIC=1` 监听 `0.0.0.0`,仅在置于 SSO 网关后时安全。
>
> `MIVO_PUBLIC_ORIGIN`(034b46c 起生产必配):debug-logs POST 同源放行需可信外部 origin,
> 否则同源浏览器 POST 全 403(客户端 debugLogger 写入失败)。推荐固定 canonical origin
> (`https://<canonical-host>`);或仅在网关 strip 客户端 XFF/XFP 且网络隔离 BFF 时设
> `MIVO_DEBUG_TRUST_XFF=1`(X-Forwarded-Proto 必须单值 `http`/`https`,多值 fail-closed)。
> 详见 `server/contracts/env-matrix.md` Debug logs 段。

镜像启动后:

- 前端静态产物由同一个 Node BFF 托管(`dist/`)
- `GET /healthz` 可直接做容器 / LB 探活
- `/api/auth/me` 生产由 SSO 网关提供;BFF 的 dev 桩默认关(见 `server/lib/auth-stub.ts`)

## Reverse Proxy

反向代理的 body limit 必须不小于 BFF 的请求上限:

- `POST /api/mivo/generate`: `MIVO_JSON_REQUEST_MAX_BYTES` 默认 `1 MiB`
- `POST /api/mivo/edit`: `MIVO_IMAGE_REQUEST_MAX_BYTES` 默认 `40 MiB`

建议把代理层限制设到 `50m`,给 multipart boundary / header 留余量。

Nginx 示例(同机反代到 BFF):

```nginx
client_max_body_size 50m;

location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

> **若用 `MIVO_DEBUG_TRUST_XFF=1` 方案**(非 `MIVO_PUBLIC_ORIGIN` 固定方案),反代/网关必须:
> ① `X-Forwarded-Proto` 注入**单值** `$scheme`(`http` 或 `https`);多值(如 `https,http`)
>   会让 BFF fail-closed(同源 POST 全 403);严禁拼接客户端自带 XFP。
> ② **strip 客户端自带的 `X-Forwarded-For`/`X-Forwarded-Proto`** 再注入网关值,否则
>   客户端可伪造 scheme 绕过同源判定;rate key 也会被客户端轮换 XFF 绕过。
> ③ BFF 端口仅网关可达(网络隔离 / bind 127.0.0.1 + 反代),防绕网关直连。
> 推荐优先用 `MIVO_PUBLIC_ORIGIN` 固定方案,避免信任 XFF 链。

> SSO 网关(`auth.dsworks.cn`)盖在反代之前,负责 `/api/auth/me` 与登录态。BFF 自身
> 不做 OAuth、不读 JWT、不连 maker server。

## Secrets

只把真实密钥注入到 BFF 进程,不要进入前端 bundle:

- `MIVO_IMAGE_API_KEY`
- `MIVO_LLM_API_KEY`(同时是 `X-Gateway-Key` 的 env 兜底)
- `MIVO_PLATFORM_KEY`
- `MIVO_DEBUG_VIEW_TOKEN`(如果需要开放 debug 报表读取)

per-user 的 `X-Mivo-Api-Key`(`mivo_` 前缀)与 `X-Gateway-Key`(`sk-` 前缀)由浏览器端
注入 header,不入 bundle;格式校验见 `server/lib/keys.ts`。

推荐顺序:

1. 运行平台的 secret/env 注入
2. systemd / container runtime 的 `EnvironmentFile`
3. 启动脚本从 secret file 读入后 `export`

不要使用任何 `VITE_*` 变量承载上述值。

## Logs And Volumes

- `MIVO_DEBUG_LOG_DIR` 需要挂持久卷,否则容器重启后远端 debug 日志会丢失
- 应用 stdout/stderr 直接交给容器平台采集
- 如果启用 `local-assets`,对应根目录也必须挂卷并且只对可信环境开放

## Public Mode Defaults

`MIVO_PUBLIC=1` 下:

- `local-assets` 默认关闭(404)
- `eagle/*` 默认关闭(404)
- `debug-logs` GET 在未提供 `MIVO_DEBUG_VIEW_TOKEN` 时默认 403
- `debug-logs` POST 同源放行需可信外部 origin(034b46c 起):必须配 `MIVO_PUBLIC_ORIGIN`
  或 `MIVO_DEBUG_TRUST_XFF=1`,否则同源浏览器 POST 全 403(客户端 debugLogger 写入失败)
- dev 桩 `/api/auth/me` 硬关(身份只由网关提供)

只有在明确需要时才显式打开:

```bash
-e MIVO_ENABLE_LOCAL_ASSETS=1
-e MIVO_ENABLE_EAGLE_PROXY=1
```

这两个端点读取宿主机文件,只建议在受控内网或带额外访问控制的环境中启用。

## 已废弃(勿用)

以下在 SSO 网关方案切换后已删除/失效,文档不再保留:

- `MIVO_BFF_TOKEN` / 旧 BFF token gate —— app 无 gate
- `JWT_SECRET` / maker JWT 验证 —— 随飞书 OAuth 骨干删除
- `MAKER_SERVER_URL` / `MIVO_FEISHU_APP_ID` / `MIVO_OAUTH_REDIRECT_URI` /
  `MIVO_DEV_AUTH_ENABLED` / `MIVO_COOKIE_SECURE` —— 飞书 OAuth + maker server 路径已删
- `server/lib/authConfig.ts` —— 该文件已不存在
