// PR #276 P1 并发锁序 barrier。真 PG 双连接,用显式事务暂停制造确定时序。
// gate:MIVO_PG_TEST=1；CI pg-suite 白名单必跑,本地默认 55443。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { PgPersistBackend } from './pgBackend'

const ENABLED = process.env.MIVO_PG_TEST === '1'
const cfg = {
  host: process.env.MIVO_PG_HOST || '127.0.0.1',
  port: Number(process.env.MIVO_PG_PORT || 55443),
  database: process.env.MIVO_PG_DB || 'mivocanvas',
  user: process.env.MIVO_PG_USER || 'mivo',
  password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const expectBlocked = async (promise: Promise<unknown>): Promise<void> => {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  await delay(40)
  expect(settled).toBe(false)
}
const within = async <T>(promise: Promise<T>, ms = 4_000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`PG barrier timed out after ${ms}ms`)), ms)),
  ])

const setup = async (b: PgPersistBackend, projectIds = ['p1']): Promise<void> => {
  for (const id of projectIds) {
    await b.ensureCreate('o', 'project', id, { name: id }, { method: 'POST', resourceKind: 'project' })
  }
}
const addCanvas = async (b: PgPersistBackend, id: string, projectId: string): Promise<void> => {
  await b.createCanvasWithCollection('o', id, { projectId, title: id }, { method: 'POST', resourceKind: 'canvas' })
}
const row = async (pool: Pool, id: string) => (await pool.query<{
  status: string
  is_deleted: boolean
  project_id: string | null
}>(
  `SELECT status, is_deleted, payload->>'projectId' AS project_id
     FROM persist_records WHERE owner_id='o' AND type='canvas' AND id=$1`,
  [id],
)).rows[0]

;(ENABLED ? describe : describe.skip)('PG archive guards — 双连接事务 barrier', () => {
  let backend: PgPersistBackend
  let pool: Pool

  beforeAll(async () => {
    backend = new PgPersistBackend({ ...cfg, maxConnections: 6, idleTimeoutMs: 5_000 })
    await backend.migrate()
    await backend.ready
    pool = new Pool({ ...cfg, max: 3 })
  })
  beforeEach(async () => backend.__reset())
  afterAll(async () => {
    await pool?.end()
    await backend?.destroy()
  })

  it('create 持 parent 锁暂停 → archive 等待后读取提交后的 child 集；无死锁且不留 archived-project 下 active child', async () => {
    await setup(backend)
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query("SELECT id FROM projects WHERE id='p1' FOR UPDATE")
      await writer.query("INSERT INTO canvases(id,owner_id,is_deleted,status) VALUES('c-new','o',false,'active')")
      await writer.query(`INSERT INTO persist_records(id,owner_id,canvas_id,type,scope,revision,order_key,is_deleted,status,payload)
        VALUES('c-new','o',NULL,'canvas','document',0,0,false,'active',$1::jsonb)`, [JSON.stringify({ projectId: 'p1', title: 'new' })])

      const archive = backend.archiveProjectTree('o', 'p1')
      await expectBlocked(archive)
      await writer.query('COMMIT')
      await expect(within(archive)).resolves.toMatchObject({ count: expect.any(Number) })
      expect(await row(pool, 'c-new')).toMatchObject({ status: 'archived', is_deleted: false, project_id: 'p1' })
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
  })

  it('move 持 target project 锁暂停 → archive 串行后归档 RETURNING 实际集合；无 stale childIds/无死锁', async () => {
    await setup(backend, ['p1', 'p2'])
    await addCanvas(backend, 'c-move', 'p2')
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query("SELECT id FROM projects WHERE id='p1' FOR UPDATE")
      await writer.query(`UPDATE persist_records
        SET payload=jsonb_set(payload,'{projectId}',to_jsonb('p1'::text)), revision=revision+1
        WHERE owner_id='o' AND type='canvas' AND id='c-move'`)

      const archive = backend.archiveProjectTree('o', 'p1')
      await expectBlocked(archive)
      await writer.query('COMMIT')
      await within(archive)
      expect(await row(pool, 'c-move')).toMatchObject({ status: 'archived', is_deleted: false, project_id: 'p1' })
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
  })

  it('unarchive 先持 parent 锁并恢复 child → softDelete 锁后检查见 active 并 blocked；成功恢复的 child 不被删', async () => {
    await setup(backend)
    await addCanvas(backend, 'c1', 'p1')
    await backend.archiveProjectTree('o', 'p1')
    const unarchiver = await pool.connect()
    try {
      await unarchiver.query('BEGIN')
      await unarchiver.query("SELECT id FROM projects WHERE id='p1' FOR UPDATE")
      await unarchiver.query("UPDATE persist_records SET status='active', payload=jsonb_set(payload,'{archivedByCascade}','false'::jsonb) WHERE owner_id='o' AND type='canvas' AND id='c1'")
      await unarchiver.query("UPDATE canvases SET status='active' WHERE id='c1' AND owner_id='o'")

      const deleting = backend.softDeleteProjectTree('o', 'p1')
      await expectBlocked(deleting)
      await unarchiver.query('COMMIT')
      await expect(within(deleting)).resolves.toEqual({ count: 0, blocked: 'active-child' })
      expect(await row(pool, 'c1')).toMatchObject({ status: 'active', is_deleted: false })
    } finally {
      await unarchiver.query('ROLLBACK').catch(() => undefined)
      unarchiver.release()
    }
  })

  it('softDelete 已按协议锁 project+project-meta+children 后暂停 → direct unarchive 等 parent；删除提交后恢复返回 0', async () => {
    await setup(backend)
    await addCanvas(backend, 'c1', 'p1')
    await backend.archiveProjectTree('o', 'p1')
    const deleting = await pool.connect()
    try {
      await deleting.query('BEGIN')
      await deleting.query("SELECT id FROM projects WHERE id='p1' FOR UPDATE")
      await deleting.query("SELECT id FROM persist_records WHERE owner_id='o' AND type='project' AND id='p1' FOR UPDATE")
      await deleting.query("SELECT id FROM persist_records WHERE owner_id='o' AND type='canvas' AND payload->>'projectId'='p1' AND is_deleted=false ORDER BY id FOR UPDATE")

      const unarchive = backend.unarchiveCanvasTree('o', 'c1')
      await expectBlocked(unarchive)
      await deleting.query("UPDATE persist_records SET is_deleted=true WHERE owner_id='o' AND type IN ('project','canvas') AND (id='p1' OR id='c1')")
      await deleting.query("UPDATE projects SET is_deleted=true WHERE id='p1' AND owner_id='o'")
      await deleting.query("UPDATE canvases SET is_deleted=true WHERE id='c1' AND owner_id='o'")
      await deleting.query('COMMIT')

      await expect(within(unarchive)).resolves.toEqual({ count: 0 })
      expect(await row(pool, 'c1')).toMatchObject({ status: 'archived', is_deleted: true })
    } finally {
      await deleting.query('ROLLBACK').catch(() => undefined)
      deleting.release()
    }
  })
})
