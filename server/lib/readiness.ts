// server/lib/readiness.ts
// P0.3 readiness probe(区别于 /healthz 的 liveness)。
// /healthz = "进程活"(恒 200,用于 pm2/docker restart 判定进程未死)。
// /readyz   = "依赖此刻可用"(PG 连接 + asset dir 可写;任何 fail → 503,部署/网关据此摘流量)。
//
// 设计:不抛错——每个 check 返 {status, reason?},computeReadiness 聚合 status。
// 抛错会让 Hono 回 500(无诊断体);返结构 + 503 让运维从响应体直接看哪个依赖挂了。
//
// persist:调 backend.ping()。memory 恒 ok(无外部依赖);PG 跑 SELECT 1(连接池探活,
// 受 P0.3 connectionTimeoutMillis 排队超时保护——池满不无限等)。
// assetDir:asset service 启用时(MIVO_ENABLE_ASSET_SERVICE=1)探写一个 probe 文件再删;
// service 关时 skipped(不参与 fail 判定——服务关即不依赖该卷)。

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveAssetStoreDir } from './assetStore'
import type { PersistBackend } from '../persist/backend'
import type { PersistBackendKind } from '../persist/pgConfig'

export type CheckStatus = 'ok' | 'fail' | 'skipped'

export type PersistCheck = {
  status: CheckStatus
  backend: PersistBackendKind
  reason?: string
}

export type AssetDirCheck = {
  status: CheckStatus
  dir: string
  reason?: string
}

export type ReadinessReport = {
  status: 'ok' | 'degraded'
  persist: PersistCheck
  assetDir: AssetDirCheck
}

/** 单调计数,避免同进程并发 probe 撞文件名。 */
let probeCounter = 0

/**
 * Probe whether the configured asset store dir is writable (P0.3 readiness).
 * 写一个临时 probe 文件再删——确认目录存在 + 可写(卷挂载正常 + 权限对)。
 * service 关时 skipped(不 fail——不依赖该卷就不该因它摘流量)。
 */
export const probeAssetDirWritable = async (
  dir: string,
  enabled: boolean,
): Promise<AssetDirCheck> => {
  if (!enabled) {
    return { status: 'skipped', dir, reason: 'asset service disabled (MIVO_ENABLE_ASSET_SERVICE!=1)' }
  }
  try {
    await fs.mkdir(dir, { recursive: true })
    const probe = path.join(dir, `.readyz-probe-${process.pid}-${probeCounter++}`)
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.unlink(probe)
    return { status: 'ok', dir }
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { status: 'fail', dir, reason }
  }
}

/**
 * 聚合 readiness:persist ping + asset dir 探写。任一 fail → degraded(503)。
 * skipped 不算 fail(依赖未启用不该摘流量)。
 */
export const computeReadiness = async (
  backend: PersistBackend,
  backendKind: PersistBackendKind,
  assetDir: string,
  assetEnabled: boolean,
): Promise<ReadinessReport> => {
  const ping = await backend.ping()
  const persist: PersistCheck = {
    status: ping.ok ? 'ok' : 'fail',
    backend: backendKind,
    reason: ping.ok ? undefined : ping.reason,
  }
  const assetDirCheck = await probeAssetDirWritable(assetDir, assetEnabled)
  const degraded = persist.status === 'fail' || assetDirCheck.status === 'fail'
  return { status: degraded ? 'degraded' : 'ok', persist, assetDir: assetDirCheck }
}

/** /readyz route handler(供 app.ts 挂载)。200 ok / 503 degraded。 */
export const readinessHandler = async (
  backend: PersistBackend,
  backendKind: PersistBackendKind,
  assetEnabled: boolean,
) => {
  const report = await computeReadiness(backend, backendKind, resolveAssetStoreDir(), assetEnabled)
  const status = report.status === 'ok' ? 200 : 503
  return { status, body: report }
}
