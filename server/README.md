# MivoCanvas BFF (server/)

P1-a 骨架:基于 Hono + `@hono/node-server` 的独立 BFF,同源托管 `dist/` 静态产物并提供 `/healthz` 探活。本 PR 只做骨架,端点平移见后续 P1-c。

## 启动

```bash
# 1. 先构建前端产物(server/ 同源托管 dist/)
npm run build

# 2. 启动 BFF(默认 127.0.0.1:8080)
npm run start:server
```

启动后日志形如:

```
[mivo-bff] listening on http://127.0.0.1:8080 [local 127.0.0.1, open (no MIVO_BFF_TOKEN)]
```

## 环境变量

| 变量 | 默认 | 作用 |
|------|------|------|
| `MIVO_PORT` | `8080` | 监听端口 |
| `MIVO_PUBLIC` | 未设置 | 设为 `1` 时监听 `0.0.0.0`(公网);**此时强制要求 `MIVO_BFF_TOKEN`,否则启动即退出** |
| `MIVO_BFF_TOKEN` | 未设置 | 访问门 token。未设置=门禁关闭(本地开放);设置后除 `/healthz` 外所有请求必须携带 token |

### Token 携带方式(门禁开启时)

二选一:

- `Authorization: Bearer <MIVO_BFF_TOKEN>`
- `X-Mivo-Bff-Token: <MIVO_BFF_TOKEN>`

`/healthz` 始终免鉴权。未授权请求返回 `401 {"error":"unauthorized"}`,响应脱敏(不回显 token、不含堆栈)。

> 访问门定位是「内部门禁/临时防滥用」,不等同用户鉴权。真实用户鉴权在 P4 对接 mivoserver;token 注入方式(header / 网关 HttpOnly cookie)在 P1-c 落地,本骨架只做 header 校验。

## 示例

```bash
# 本地默认(无门禁)
npm run start:server
curl http://127.0.0.1:8080/healthz        # 200 {"status":"ok"}
curl http://127.0.0.1:8080/               # 200 index.html

# 公网模式(必须有 token)
MIVO_PUBLIC=1 MIVO_BFF_TOKEN=secret npm run start:server
curl http://127.0.0.1:8080/healthz                    # 200(免鉴权)
curl http://127.0.0.1:8080/                           # 401
curl -H "Authorization: Bearer secret" http://127.0.0.1:8080/   # 200 index.html
```

## 目录结构

```
server/
├── index.ts        # 入口:Hono app + healthz + 访问门 + serveStatic + SPA fallback + bind
├── routes/         # 占位:P1-c 端点平移(生成组/资产组/debug-logs)
├── platform/       # 占位:P1-c 平台通道 helpers(token 缓存/chatSession/poll/download)
├── lib/            # 占位:P1-c 共享工具(请求日志/脱敏/契约)
└── README.md       # 本文件
```

## 类型检查

`server/` 由独立的 `tsconfig.server.json` 纳入 `tsc -b` 项目引用,不污染前端 bundle(`noEmit`,仅类型检查;Vite 不会打包 `server/` 中任何模块)。

## 回滚

本 PR 只新增 `server/`、`tsconfig.server.json`、`start:server` 脚本与三个依赖(hono / @hono/node-server / tsx)。**未改 `vite.config.ts`、未改 `src/`、未改 dev/build 流程**。回滚方式:

```bash
git revert <this-pr-commit>      # 撤销本 PR
# 或手动:删除 server/、tsconfig.server.json,从 package.json 移除 start:server 与三依赖,npm install
```

`start:server` 是 opt-in,不设不跑即无影响。P1-d 才会把 dev 接到 BFF(`vite.config.ts` 的 `server.proxy`),届时另有 `MIVO_API_MODE` 回滚开关。
