# server/platform/

P1-c 平台通道 helpers 占位。从 `vite.config.ts` L587-793 迁入:内存 token 缓存、chatSession ensure、authRetry、文件 upload/signUrl/poll/download。可测项:token 单飞、chatSession 单飞、各 401 后刷新且只重试一次、重试仍败即报错不回落、上传失败 502 脱敏。
