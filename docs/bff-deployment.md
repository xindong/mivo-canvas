# MivoCanvas BFF Deployment

## Container

```bash
docker build -t mivocanvas-bff .
docker run --rm -p 8080:8080 \
  -e MIVO_PUBLIC=1 \
  -e MIVO_BFF_TOKEN=replace-me \
  -e MIVO_IMAGE_API_KEY=replace-me \
  -e MIVO_LLM_API_KEY=replace-me \
  -e MIVO_PLATFORM_KEY=replace-me \
  -e MIVO_DEBUG_LOG_DIR=/var/lib/mivo/debug-logs \
  -v "$PWD/data/debug-logs:/var/lib/mivo/debug-logs" \
  mivocanvas-bff
```

镜像启动后:

- 前端静态产物由同一个 Node BFF 托管(`dist/`)
- `GET /healthz` 可直接做容器 / LB 探活
- `MIVO_PUBLIC=1` 时必须同时提供 `MIVO_BFF_TOKEN`

## Reverse Proxy

反向代理的 body limit 必须不小于 BFF 的请求上限:

- `POST /api/mivo/generate`: `MIVO_JSON_REQUEST_MAX_BYTES` 默认 `1 MiB`
- `POST /api/mivo/edit`: `MIVO_IMAGE_REQUEST_MAX_BYTES` 默认 `40 MiB`

建议把代理层限制设到 `50m`，给 multipart boundary / header 留余量。

Nginx 示例:

```nginx
client_max_body_size 50m;

location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Secrets

只把真实密钥注入到 BFF 进程，不要进入前端 bundle:

- `MIVO_IMAGE_API_KEY`
- `MIVO_LLM_API_KEY`
- `MIVO_PLATFORM_KEY`
- `MIVO_BFF_TOKEN`
- `MIVO_DEBUG_VIEW_TOKEN` (如果需要开放 debug 报表读取)

推荐顺序:

1. 运行平台的 secret/env 注入
2. systemd / container runtime 的 `EnvironmentFile`
3. 启动脚本从 secret file 读入后 `export`

不要使用任何 `VITE_*` 变量承载上述值。

## Logs And Volumes

- `MIVO_DEBUG_LOG_DIR` 需要挂持久卷，否则容器重启后远端 debug 日志会丢失
- 应用 stdout/stderr 直接交给容器平台采集
- 如果启用 `local-assets`，对应根目录也必须挂卷并且只对可信环境开放

## Public Mode Defaults

`MIVO_PUBLIC=1` 下:

- `local-assets` 默认关闭(404)
- `eagle/*` 默认关闭(404)
- `debug-logs` GET 在未提供 `MIVO_DEBUG_VIEW_TOKEN` 时默认 403

只有在明确需要时才显式打开:

```bash
-e MIVO_ENABLE_LOCAL_ASSETS=1
-e MIVO_ENABLE_EAGLE_PROXY=1
```

这两个端点读取宿主机文件，只建议在受控内网或带额外访问控制的环境中启用。
