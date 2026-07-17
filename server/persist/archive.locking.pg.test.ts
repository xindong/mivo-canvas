// PR #276 P1 并发锁序 barrier。真 PG 多连接,所有“被阻塞”断言均轮询 pg_stat_activity 的
// wait_event_type='Lock' rendezvous；禁止用固定 40ms 未 settle 充当并发证据。
// gate:MIVO_PG_TEST=1；CI pg-suite 白名单必跑,本地默认 55443。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { PgPersistBackend } from './pgBackend'

const ENABLED = process.env.MIVO_PG_TEST === '1'
const BACKEND_APP = 'mivo_archive_locking_backend'
const BARRIER_APP = 'mivo_archive_locking_barrier'
const cfg = {
  host: process.env.MIVO_PG_HOST || '127.0.0.1',
  port: Number(process.env.MIVO_PG_PORT || 55443),
  database: process.env.MIVO_PG_DB || 'mivocanvas',
  user: process.env.MIVO_PG_USER || 'mivo',
  password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 真 rendezvous：只在 backend application_name 的会话进入 PG Lock wait 后才放开 raw 事务。 */
const waitForBackendLock = async (observer: Pool, label: string, timeoutMs = 12_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const waiting = await observer.query<{ pid: number; wait_event: string | null }>(
      `SELECT pid, wait_event
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND wait_event_type = 'Lock'`,
      [BACKEND_APP],
    )
    if (waiting.rowCount && waiting.rowCount > 0) return
    await delay(20)
  }
  throw new Error(`PG lock rendezvous timed out after ${timeoutMs}ms: ${label}`)
}

const within = async <T>(promise: Promise<T>, ms = 10_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PG barrier timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const setup = async (b: PgPersistBackend, projectIds = ['p1']): Promise<void> => {
  for (const id of projectIds) {
    await b.ensureCreate('o', 'project', id, { name: id }, { method: 'POST', resourceKind: 'project' })
  }
}
const addCanvas = async (b: PgPersistBackend, id: string, projectId: string): Promise<void> => {
  await b.createCanvasWithCollection('o', id, { projectId, title: id }, { method: 'POST', resourceKind: 'canvas' })
}
const canvasRow = async (pool: Pool, id: string) => (await pool.query<{
  status: string
  is_deleted: boolean
  project_id: string | null
}>(
  `SELECT status, is_deleted, payload->>'projectId' AS project_id
     FROM persist_records WHERE owner_id='o' AND type='canvas' AND id=$1`,
  [id],
)).rows[0]
const projectRow = async (pool: Pool, id: string) => (await pool.query<{
  meta_deleted: boolean
  index_deleted: boolean
  meta_status: string
  index_status: string
}>(
  `SELECT pr.is_deleted AS meta_deleted, p.is_deleted AS index_deleted,
          pr.status AS meta_status, p.status AS index_status
     FROM persist_records pr JOIN projects p ON p.id=pr.id
    WHERE pr.owner_id='o' AND pr.type='project' AND pr.id=$1`,
  [id],
)).rows[0]

;(ENABLED ? describe : describe.skip)('PG archive guards — pg_stat_activity Lock rendezvous', () => {
  let backend: PgPersistBackend
  let backendPool: Pool
  let pool: Pool

  beforeAll(async () => {
    backendPool = new Pool({ ...cfg, max: 6, application_name: BACKEND_APP })
    backend = new PgPersistBackend({ ...cfg, maxConnections: 6, idleTimeoutMs: 5_000 }, backendPool)
    await backend.ready
    pool = new Pool({ ...cfg, max: 5, application_name: BARRIER_APP })
  })
  beforeEach(async () => backend.__reset())
  afterAll(async () => {
    await backend?.destroy()
    await backendPool?.end()
    await pool?.end()
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
      await waitForBackendLock(pool, 'create → archive')
      await writer.query('COMMIT')
      await expect(within(archive)).resolves.toMatchObject({ count: expect.any(Number) })
      expect(await canvasRow(pool, 'c-new')).toMatchObject({ status: 'archived', is_deleted: false, project_id: 'p1' })
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
      await waitForBackendLock(pool, 'move → archive project')
      await writer.query('COMMIT')
      await within(archive)
      expect(await canvasRow(pool, 'c-move')).toMatchObject({ status: 'archived', is_deleted: false, project_id: 'p1' })
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
      await waitForBackendLock(pool, 'unarchive → softDelete')
      await unarchiver.query('COMMIT')
      await expect(within(deleting)).resolves.toEqual({ count: 0, blocked: 'active-child' })
      expect(await canvasRow(pool, 'c1')).toMatchObject({ status: 'active', is_deleted: false })
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
      await waitForBackendLock(pool, 'softDelete → direct unarchive')
      await deleting.query("UPDATE persist_records SET is_deleted=true WHERE owner_id='o' AND type IN ('project','canvas') AND (id='p1' OR id='c1')")
      await deleting.query("UPDATE projects SET is_deleted=true WHERE id='p1' AND owner_id='o'")
      await deleting.query("UPDATE canvases SET is_deleted=true WHERE id='c1' AND owner_id='o'")
      await deleting.query('COMMIT')

      await expect(within(unarchive)).resolves.toEqual({ count: 0 })
      expect(await canvasRow(pool, 'c1')).toMatchObject({ status: 'archived', is_deleted: true })
    } finally {
      await deleting.query('ROLLBACK').catch(() => undefined)
      deleting.release()
    }
  })

  const restoreAgainstProjectFirstWriter = async (
    label: string,
    startRestore: () => Promise<unknown>,
  ): Promise<void> => {
    await setup(backend)
    await backend.softDeleteProjectTree('o', 'p1')
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query("SELECT id FROM projects WHERE id='p1' FOR UPDATE")
      const restoring = startRestore()
      await waitForBackendLock(pool, label)
      // 镜像 archive/softDelete 的 projects-first 临界区：持 projects 后再写 project meta。
      // 若 restore 仍先持 meta 再等 projects,此 UPDATE 与 restore 构成真 40P01 锁环。
      await writer.query("UPDATE persist_records SET status='archived', updated_at=now() WHERE owner_id='o' AND type='project' AND id='p1'")
      await writer.query("UPDATE projects SET status='archived', updated_at=now() WHERE owner_id='o' AND id='p1'")
      await writer.query('COMMIT')
      await expect(within(restoring)).resolves.toBeDefined()
      expect(await projectRow(pool, 'p1')).toEqual({
        meta_deleted: false,
        index_deleted: false,
        meta_status: 'archived',
        index_status: 'archived',
      })
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
  }

  it('restoreProjectTree vs projects-first writer：无 40P01,终态等价 writer→restore', async () => {
    await restoreAgainstProjectFirstWriter(
      'restoreProjectTree projects-first',
      () => backend.restoreProjectTree('o', 'p1'),
    )
  })

  it('ensureCreate(project deleted) restore vs projects-first writer：无 40P01', async () => {
    await restoreAgainstProjectFirstWriter(
      'ensureCreate restore projects-first',
      () => backend.ensureCreate('o', 'project', 'p1', { name: 'restored' }, { method: 'POST', resourceKind: 'project' }),
    )
  })

  it('upsert(project deleted) restore vs projects-first writer：无 40P01', async () => {
    await restoreAgainstProjectFirstWriter(
      'upsert restore projects-first',
      () => backend.upsert('o', 'project', 'p1', { name: 'restored' }, { method: 'PUT', resourceKind: 'project', base: 0 }),
    )
  })

  const moveWhileDirectCanvasMutationWaits = async (target: 'archive' | 'unarchive'): Promise<void> => {
    await setup(backend, ['parent-a', 'parent-b'])
    await addCanvas(backend, 'c-parent-move', 'parent-a')
    if (target === 'unarchive') await backend.archiveCanvasTree('o', 'c-parent-move')
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query("SELECT id FROM projects WHERE id='parent-a' FOR UPDATE")
      const mutation = target === 'archive'
        ? backend.archiveCanvasTree('o', 'c-parent-move')
        : backend.unarchiveCanvasTree('o', 'c-parent-move')
      await waitForBackendLock(pool, `parent-a→parent-b move × ${target}`)

      const current = await backend.get('o', 'canvas', 'c-parent-move')
      expect(current.kind).toBe('found')
      if (current.kind !== 'found') throw new Error('missing canvas before move')
      const moved = await backend.upsert(
        'o',
        'canvas',
        'c-parent-move',
        { ...(current.record.payload as object), projectId: 'parent-b' },
        { method: 'PUT', resourceKind: 'canvas', base: current.record.revision },
      )
      expect(moved.kind).toBe('updated')
      await blocker.query('COMMIT')

      const result = await within(mutation)
      expect(result.retryableConflict).not.toBe(true)
      expect(result.count).toBe(1)
      expect(await canvasRow(pool, 'c-parent-move')).toMatchObject({
        project_id: 'parent-b',
        status: target === 'archive' ? 'archived' : 'active',
        is_deleted: false,
      })
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }
  }

  it('parentA→parentB move × direct archive：CAS miss rollback 后新事务重锁,禁止 200 未生效', async () => {
    await moveWhileDirectCanvasMutationWaits('archive')
  })

  it('parentA→parentB move × direct unarchive：CAS miss rollback 后新事务重锁,禁止 200 未生效', async () => {
    await moveWhileDirectCanvasMutationWaits('unarchive')
  })

  it('standalone→parent move × direct archive：IS NULL CAS miss 后重试新 parent,请求最终生效', async () => {
    await setup(backend, ['parent-b'])
    await backend.ensureCreate('o', 'canvas', 'c-standalone', { title: 'standalone' }, { method: 'POST', resourceKind: 'canvas' })
    const mover = await pool.connect()
    try {
      await mover.query('BEGIN')
      await mover.query("SELECT id FROM projects WHERE id='parent-b' FOR UPDATE")
      await mover.query("SELECT id FROM persist_records WHERE owner_id='o' AND type='canvas' AND id='c-standalone' FOR UPDATE")
      const archive = backend.archiveCanvasTree('o', 'c-standalone')
      await waitForBackendLock(pool, 'standalone→parent move × archive')
      await mover.query(`UPDATE persist_records
        SET payload=jsonb_set(payload,'{projectId}',to_jsonb('parent-b'::text)), revision=revision+1
        WHERE owner_id='o' AND type='canvas' AND id='c-standalone'`)
      await mover.query('COMMIT')

      const result = await within(archive)
      expect(result.retryableConflict).not.toBe(true)
      expect(result.count).toBe(1)
      expect(await canvasRow(pool, 'c-standalone')).toMatchObject({
        project_id: 'parent-b', status: 'archived', is_deleted: false,
      })
    } finally {
      await mover.query('ROLLBACK').catch(() => undefined)
      mover.release()
    }
  })
})
