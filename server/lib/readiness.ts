// server/lib/readiness.ts
// P0.3 readiness probe(区别于 /healthz 的 liveness)+ 返修 F1/F2/F7。
// /healthz = "进程活"(恒 200,用于 pm2/docker restart 判定进程未死)。
// /readyz   = "依赖此刻可用"(PG persist + permission 连接 + asset dir 可写;任一 fail → 503,部署/网关据此摘流量)。
//
// 设计:不抛错——每个 check 返结构 + 稳定 reason code;computeReadiness 聚合 status。
// 抛错会让 Hono 回 500(无诊断体且泄漏栈);返结构 + 503 让运维从响应体直接看哪个依赖挂了。
//
// 返修要点:
//  - F1:asset dir probe **禁 mkdir**。生产持久卷漏挂载时,若 probe 自建目录则资产写到宿主根盘
//        还报 ready=200(假绿,资产写错盘)。目录不存在/非目录/不可写 → fail(503)。建目录归部署前置(runbook §4)。
//  - F2:persist + permission 两个 PG backend 共享一个 Pool(单预算);readyz 探活两者
//        (permission DB 挂 → 503)。memory 恒 ok。
//  - F7:probe 结果短 TTL 缓存(节流 inode churn);probe 文件 finally 清理(残留窗口收敛)。
//        503 响应体只回**稳定 reason code**(dir-missing/parent-not-dir/not-writable/pg-unreachable),
//        绝对路径 + 原始 Error 细节进服务端日志(console.error → pm2 err.log)——
//        index.ts public 模式 0.0.0.0 无 auth gate,响应体不暴露内部路径/凭据线索。

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveAssetStoreDir } from './assetStore'
import type { PersistBackend } from '../persist/backend'
import type { PermissionBackend } from './permissions'
import type { PersistBackendKind } from '../persist/pgConfig'

export type CheckStatus = 'ok' | 'fail' | 'skipped'

/** 依赖 check(persist / permission 共用)。reason 为稳定 code,不泄露路径/原始 error。 */
export type DepCheck = {
  status: CheckStatus
  backend: PersistBackendKind
  reason?: string
}

export type AssetDirCheck = {
  status: CheckStatus
  /** 仅 ok/skipped 回显配置路径(ops via localhost 探查用);fail 时不回显(F7:防 public 503 暴露绝对路径)。 */
  dir?: string
  /** 稳定 code(不暴露绝对路径/原始 Error)。 */
  reason?: string
}

export type ReadinessReport = {
  status: 'ok' | 'degraded'
  persist: DepCheck
  permission: DepCheck
  assetDir: AssetDirCheck
}

/** F7:probe 结果 TTL 缓存(ms)。同 dir 的连续 /readyz 请求在窗内复用上次结果,节流 inode create/unlink churn。 */
const PROBE_TTL_MS = 2000
type CachedProbe = { dir: string; enabled: boolean; result: AssetDirCheck; expiresAt: number }
let cachedAssetProbe: CachedProbe | null = null

/** 任何具备 ping() 的后端(persist / permission)。 */
type Pingable = { ping(): Promise<{ ok: true } | { ok: false; reason: string }> }

/**
 * F1+F7:asset dir probe(禁 mkdir)。
 * - enabled=false → skipped(不参与 fail 判定——不依赖该卷就不该因它摘流量)。
 * - dir 不存在(ENOENT)→ fail 'dir-missing'(漏挂载必须 503,F1)。
 * - 路径/父段是文件(ENOTDIR)→ fail 'parent-not-dir'。
 * - 不可写(EACCES/EROFS)→ fail 'not-writable'。
 * - 无空间(ENOSPC)→ fail 'no-space'。
 * - 其它 → fail 'probe-failed'。
 * F7:TTL 缓存复用(节流);probe 文件 finally 清理;reason 稳定 code;dir 仅 ok/skipped 回显。
 */
export const probeAssetDirWritable = async (
  dir: string,
  enabled: boolean,
  now: number = Date.now(),
): Promise<AssetDirCheck> => {
  if (!enabled) {
    return { status: 'skipped', dir, reason: 'asset service disabled (MIVO_ENABLE_ASSET_SERVICE!=1)' }
  }
  // F7:cache hit(同 dir+enabled 且未过期)→ 复用,跳过 fs ops,节流 inode churn。
  if (cachedAssetProbe && cachedAssetProbe.dir === dir && cachedAssetProbe.enabled === enabled && cachedAssetProbe.expiresAt > now) {
    return cachedAssetProbe.result
  }
  const result = await probeAssetDirWritableUncached(dir)
  cachedAssetProbe = { dir, enabled, result, expiresAt: now + PROBE_TTL_MS }
  return result
}

const probeAssetDirWritableUncached = async (dir: string): Promise<AssetDirCheck> => {
  // F1:不 mkdir。先 stat 确认目录存在且是目录类型——漏挂载卷必须 fail,不许自愈假绿。
  let stat
  try {
    stat = await fs.stat(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    console.error(`[readyz] asset dir stat failed: dir=${dir} code=${code}`)
    if (code === 'ENOENT') return { status: 'fail', reason: 'dir-missing' }
    return { status: 'fail', reason: mapStatCode(code) }
  }
  if (!stat.isDirectory()) {
    // 配置路径指向一个已存在的文件(非目录)。
    return { status: 'fail', reason: 'parent-not-dir' }
  }
  // 目录存在 → 探写确认可写(卷挂载正常 + 权限对)。固定 sentinel 文件名;内容幂等('ok'),
  // 即使 TTL 失效后两并发 probe 同时写也无害;finally 清理收敛残留窗口。
  const probe = path.join(dir, '.readyz-probe')
  try {
    await fs.writeFile(probe, 'ok', 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    console.error(`[readyz] asset dir probe write failed: dir=${dir} code=${code} msg=${(error as Error).message}`)
    return { status: 'fail', reason: mapWriteCode(code) }
  } finally {
    // F7:finally 清理——探写成功后必删;探写失败时文件可能未创建,unlink 抛 ENOENT 被吞。
    try {
      await fs.unlink(probe)
    } catch {
      /* 探写未创建文件或并发已被删——忽略 */
    }
  }
  return { status: 'ok', dir }
}

const mapStatCode = (code: string | undefined): string => {
  if (code === 'ENOTDIR') return 'parent-not-dir'
  if (code === 'EACCES') return 'not-writable'
  return 'probe-failed'
}
const mapWriteCode = (code: string | undefined): string => {
  if (code === 'EACCES' || code === 'EROFS') return 'not-writable'
  if (code === 'ENOSPC') return 'no-space'
  if (code === 'ENOSYS') return 'probe-failed'
  return 'probe-failed'
}

/**
 * F7:把 backend.ping() 结果转稳定 DepCheck。ok → ok;fail → reason 'pg-unreachable'
 * (不回显原始 error.message——PG 错误可能含连接串/用户名,public 0.0.0.0 无 auth gate 不暴露)。
 * 细节(ping.reason / thrown.message)进 console.error → pm2 err.log,运维本地查日志。
 */
const pingStable = async (backend: Pingable, kind: PersistBackendKind): Promise<DepCheck> => {
  try {
    const ping = await backend.ping()
    if (ping.ok) return { status: 'ok', backend: kind }
    console.error(`[readyz] ${kind} backend ping fail: ${ping.reason}`)
    return { status: 'fail', backend: kind, reason: 'pg-unreachable' }
  } catch (error) {
    console.error(`[readyz] ${kind} backend ping threw: ${(error as Error).message}`)
    return { status: 'fail', backend: kind, reason: 'pg-unreachable' }
  }
}

/**
 * 聚合 readiness:persist ping + permission ping + asset dir 探写。任一 fail → degraded(503)。
 * skipped 不算 fail(依赖未启用不该摘流量)。
 */
export const computeReadiness = async (opts: {
  persist: PersistBackend
  persistKind: PersistBackendKind
  permission: PermissionBackend
  permissionKind: PersistBackendKind
  assetDir: string
  assetEnabled: boolean
  now?: number
}): Promise<ReadinessReport> => {
  const persist = await pingStable(opts.persist, opts.persistKind)
  const permission = await pingStable(opts.permission, opts.permissionKind)
  const assetDirCheck = await probeAssetDirWritable(opts.assetDir, opts.assetEnabled, opts.now)
  const degraded =
    persist.status === 'fail' || permission.status === 'fail' || assetDirCheck.status === 'fail'
  return { status: degraded ? 'degraded' : 'ok', persist, permission, assetDir: assetDirCheck }
}

/** /readyz route handler(供 app.ts 挂载)。200 ok / 503 degraded。 */
export const readinessHandler = async (opts: {
  persist: PersistBackend
  persistKind: PersistBackendKind
  permission: PermissionBackend
  permissionKind: PersistBackendKind
  assetEnabled: boolean
}) => {
  const report = await computeReadiness({
    persist: opts.persist,
    persistKind: opts.persistKind,
    permission: opts.permission,
    permissionKind: opts.permissionKind,
    assetDir: resolveAssetStoreDir(),
    assetEnabled: opts.assetEnabled,
  })
  const status = report.status === 'ok' ? 200 : 503
  return { status, body: report }
}
