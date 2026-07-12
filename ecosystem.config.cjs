// ecosystem.config.cjs — MivoCanvas BFF pm2 进程看护配置(P0.3 运行加固)。
//
// 生产部署:服务器 `/AIGC_Group/mivo-canvas/` 下,以 yanjian 身份跑 deploy.sh,后者
// `pm2 startOrRestart ecosystem.config.cjs --update-env`(首启=start,已存=startOrRestart;
// --update-env 重载 env 块 + 新 ecosystem)。**禁用裸 `pm2 restart mivo-canvas`**(按名 restart
// 不重载 ecosystem env——改名/改 MIVO_PG_MAX_CONNECTIONS/MIVO_ASSET_STORE_DIR 后旧值不生效,
// 9:00/17:00 自动部署有中断风险;见 runbook §1.3 F6)。CLAUDE.md 部署规则:一律走 PR + CI 合 main;
// 服务器只做 pull 部署;pm2 以 yanjian 为主。
//
// 为什么 .cjs:package.json `"type":"module"` → .js 会被当 ESM,`module.exports` 失效;
// .cjs 显式 CommonJS,pm2 稳定加载。
//
// ⚠️ 密码不入库:MIVO_PG_PASSWORD 不写在此处(本文件入 git)。服务器侧由 deploy.sh
// 从 ops/postgres/.env 读取后 export 进环境,再 `pm2 startOrRestart ecosystem.config.cjs --update-env`
// (与上方 :4 同一命令;deploy.sh 仅在服务器,不入仓库,见 CLAUDE.md 部署规则)。ecosystem
// 的 env 块只放非密 env;缺 MIVO_PG_PASSWORD 时 BFF 启动 fail visibly
// (resolvePersistBackendConfig 抛错,不静默降级 memory)。
//
// 关联文档:docs/runbook/p0.3-runtime-hardening.md(pm2 看护 / /readyz / 连接预算 /
// asset dir 固定 / restore 含 asset)。

module.exports = {
  apps: [
    {
      name: 'mivo-canvas',
      // BFF 入口(npm run start:server = tsx server/index.ts)。
      // 注:生产若改走编译产物(`node dist-server/...`),改 script/args 即可;此处沿用现有 start:server。
      script: 'npm',
      args: 'run start:server',
      // 服务器仓库落地路径;cwd 固定,杜绝随启动目录漂移(dist/ 等相对路径解析稳定)。
      cwd: '/AIGC_Group/mivo-canvas',
      // 单实例 BFF:PG backend 用 in-process 全局索引缓存(persist_records 单真相源,
      // projectIndex/canvasIndex 启动预热;多实例协作留 T1.4+,见 pg-backend-schema.md §4)。
      // exec_mode=fork + instances=1;改 cluster 须先解决缓存一致性。
      exec_mode: 'fork',
      instances: 1,

      // ── 内存看护:超限即重启(防内存泄漏把进程拖垮)──────────────────────────────
      // BFF(Node + Kysely/pg + Hono)保守 1G;PG compose 限 2G,BFF 独立于此。
      // ⚠ 剩余风险(双审):1G 无 RSS 基线(尚未实测生产峰值 RSS);"BFF+Leafer" 旧表述不实——
      //   Leafer 跑在浏览器(客户端),不在 pm2 BFF 进程内,不计入此 RSS。生产上线后采一轮峰值
      //   再据实调(见 runbook §剩余风险)。触即 restart(pm2 max_memory_restart);过载重启后 /readyz 自会重新探活。
      max_memory_restart: '1G',

      // ── 重启风暴保护(防 crash-loop 反复重启打满 CPU/日志)──────────────────────
      // min_uptime:进程起后活不到该时长 → 视为异常退出,计入重启计数。
      min_uptime: '15s',
      // max_restarts:在 `restart_delay × max_restarts` 时间窗内重启超该数 → pm2 停止
      // 重启(标 errored),避免无限 crash-loop。人工 `pm2 startOrRestart ecosystem.config.cjs
      // --update-env` 可解除(同部署命令,重启时一并重载 ecosystem env,禁裸 `pm2 restart`)。
      max_restarts: 10,
      // 两次重启间的固定退避(非 crash-loop 的常规重启用此固定值)。
      restart_delay: 3000,
      // P0.3 返修 F5:指数退避必须用**数值**字段 `exp_backoff_restart_delay`(ms)。
      // PM2 不认对象形式 `exp_backoff_restart: { max_delay }`——该写法会被忽略,
      // 实际只剩固定 restart_delay=3000,指数退避从未启用(双审定为 P1 假绿)。
      // 公式:delay = exp_backoff_restart_delay * 2^(连续崩溃次数),PM2 自动上限 15000ms。
      // 100ms 起步,逐次翻倍(100→200→400→...→15000 封顶),给依赖(PG/网关)恢复时间。
      exp_backoff_restart_delay: 100,

      // ── 生产 env(非密;密码由 deploy.sh 注入,见顶部说明)──────────────────────
      env: {
        NODE_ENV: 'production',
        // public/生产:监听 0.0.0.0 + 收紧 feature flag;SSO 网关(auth.dsworks.cn)在前。
        MIVO_PUBLIC: '1',
        MIVO_PORT: '8080',

        // P0.3 固定 asset dir(杜绝随 cwd 漂移):服务端 blob 存储显式指向持久卷,
        // 不用默认 ~/.mivo-canvas/assets(那会随 HOME/启动用户漂移)。
        MIVO_ENABLE_ASSET_SERVICE: '1',
        MIVO_ASSET_STORE_DIR: '/AIGC_Group/mivo-canvas-data/assets',

        // P0.3 PG backend:生产走 PG(灰度启用);连接参数(密码除外)在此固化。
        MIVO_PERSIST_BACKEND: 'pg',
        MIVO_PG_HOST: '127.0.0.1',
        MIVO_PG_PORT: '55442', // 共享机 5432 被占,走 55442(见 t1.1 runbook §0.1)
        MIVO_PG_DB: 'mivocanvas',
        MIVO_PG_USER: 'mivo',
        // MIVO_PG_PASSWORD:不入库,deploy.sh 从 ops/postgres/.env export。
        // P0.3 连接预算(见 runbook §容量预算):
        MIVO_PG_MAX_CONNECTIONS: '10', // 池上限(单实例保守;多实例时 Σ ≤ PG max_connections 70%)
        MIVO_PG_IDLE_TIMEOUT_MS: '30000', // 空闲连接 30s 后关
        MIVO_PG_CONNECTION_TIMEOUT_MS: '5000', // 池满排队等 5s,超时即抛(fail fast)
      },

      // ── 日志(写持久卷,不进仓库;pm2-logrotate 做轮转,见 runbook §日志轮转)──
      out_file: '/AIGC_Group/mivo-canvas-data/pm2/mivo-canvas.out.log',
      error_file: '/AIGC_Group/mivo-canvas-data/pm2/mivo-canvas.err.log',
      // 合并 stdout/stderr 到同一日志行序;加时间戳前缀(可对齐 BFF 自带时间戳)。
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // 避免非 TTY 下过多缓冲(部署日志即时落盘)。
      disable_logs: false,
    },
  ],
}
