# server/routes/

P1-c 端点平移占位。按路线图 §6.1 清单分三组 PR 迁入:

- 生成组:`/api/mivo/generate`、`/api/mivo/edit`、`/api/mivo/enhance` + 平台 helpers
- 资产组:`/api/mivo/local-assets`、`/api/mivo/eagle/*`、`/api/mivo/pinterest/status`
- debug-logs:`/api/mivo/debug-logs`(POST/GET)

平移原则:响应 body shape 与 dev middleware 原样一致,不引入新 envelope。详见 `worktrees/docs-productization-roadmap/docs/plan/productization-roadmap.md` §6。
