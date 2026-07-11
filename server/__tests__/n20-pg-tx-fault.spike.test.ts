// server/__tests__/n20-pg-tx-fault.spike.test.ts
// N2-0 返修 Gate3 PG 侧(P1-2):真实 PG transaction fault injection + asset saga 边界。
//
// ★ spike 属性:N2-0 决策证据,证明 Figma 式 server-side 事务路径可跨 record/跨介质原子回滚。
//   gate:MIVO_PG_TEST=1(本地 brew PG port 55443,独立 DB mivocanvas_unit);CI 无 PG 跳过(describe.skipIf)。
//   用专用 n20_* 临时表(不依赖 mivo schema migrations),raw SQL 建模 N2-1 deleteNodeCascade 契约。
//
// 证明维度:
//   1. 原子提交:BEGIN; 删 node + 级联删 edges;COMMIT → node + edges 全删(无中间态对远端可见,但 PG 单连原子是基础)。
//   2. fault injection:BEGIN; 删 edges; 注入 SQL 错误;ROLLBACK → node + edges 全在(无 partial,回滚原子)。
//   3. asset saga 跨介质边界:node 引用 asset;删 node + 减 asset refcount 同事务;fault → rollback 两边不动。
//   对照真实 Yjs:Yjs intra-doc transact 原子(G3-real-1),但跨 Y.Doc/跨文件资产 = 非原子(G3-real-3);
//   PG server-side 事务可跨表(等效跨 record)+ 跨 asset 行原子回滚——Figma 式此 gate 真实占优(已验)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'

const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'

const pgConn = () => ({
  host: process.env.MIVO_PG_HOST || '127.0.0.1',
  port: Number(process.env.MIVO_PG_PORT || 55443),
  database: process.env.MIVO_PG_UNIT_DB || 'mivocanvas_unit',
  user: process.env.MIVO_PG_USER || 'mivo',
  password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
  max: 5,
  idleTimeoutMillis: 5000,
})

let pool: Pool | null = null

beforeAll(async () => {
  if (!PG_TEST_ENABLED) return
  const cfg = pgConn()
  pool = new Pool(cfg)
  // 建专用临时表(不依赖 mivo schema)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS n20_nodes (id text PRIMARY KEY, title text, asset_id text);
    CREATE TABLE IF NOT EXISTS n20_edges (id text PRIMARY KEY, from_id text NOT NULL, to_id text NOT NULL);
    CREATE TABLE IF NOT EXISTS n20_assets (id text PRIMARY KEY, refcount integer NOT NULL DEFAULT 0);
  `)
})

afterAll(async () => {
  if (!pool) return
  await pool.query('DROP TABLE IF EXISTS n20_nodes; DROP TABLE IF EXISTS n20_edges; DROP TABLE IF EXISTS n20_assets;')
  await pool.end()
})

describe.skipIf(!PG_TEST_ENABLED)('N2-0 返修 Gate3 PG 侧: 真实事务原子提交 + fault injection 回滚 + asset saga 边界', () => {
  async function seed() {
    await pool!.query('TRUNCATE n20_nodes, n20_edges, n20_assets')
    await pool!.query("INSERT INTO n20_nodes(id,title,asset_id) VALUES ('n1','orig','a1'),('n2','n2','a2')")
    await pool!.query("INSERT INTO n20_edges(id,from_id,to_id) VALUES ('e1','n1','n2'),('e2','n2','n1'),('e3','n2','n2')")
    await pool!.query("INSERT INTO n20_assets(id,refcount) VALUES ('a1',1),('a2',1)")
  }

  async function counts() {
    const n = await pool!.query('SELECT count(*)::int AS c FROM n20_nodes WHERE id=$1', ['n1'])
    const e = await pool!.query('SELECT count(*)::int AS c FROM n20_edges WHERE from_id=$1 OR to_id=$1', ['n1'])
    const eAll = await pool!.query('SELECT count(*)::int AS c FROM n20_edges')
    const a = await pool!.query('SELECT refcount FROM n20_assets WHERE id=$1', ['a1'])
    return { n1: n.rows[0].c, n1Edges: e.rows[0].c, allEdges: eAll.rows[0].c, a1Ref: a.rows[0].refcount }
  }

  it('PG-T1 原子提交:BEGIN 删 n1+级联 edges + COMMIT → n1 与其 edges 全删,e3 保留', async () => {
    await seed()
    expect((await counts()).allEdges).toBe(3)
    await pool!.query('BEGIN')
    await pool!.query('DELETE FROM n20_edges WHERE from_id=$1 OR to_id=$1', ['n1']) // 删 e1,e2
    await pool!.query('DELETE FROM n20_nodes WHERE id=$1', ['n1'])                   // 删 n1
    await pool!.query('COMMIT')
    const c = await counts()
    expect(c.n1).toBe(0)        // ★ n1 删
    expect(c.n1Edges).toBe(0)   // ★ 引用 n1 的 edges 全删(原子)
    expect(c.allEdges).toBe(1)  // e3 保留(n2→n2)
  })

  it('PG-T2 fault injection:BEGIN 删 edges + 注入错误 + ROLLBACK → n1 与 edges 全在(无 partial)', async () => {
    await seed()
    const before = await counts()
    expect(before.n1).toBe(1)
    expect(before.n1Edges).toBe(2) // e1,e2
    await pool!.query('BEGIN')
    await pool!.query('DELETE FROM n20_edges WHERE from_id=$1 OR to_id=$1', ['n1']) // 删了 edges(未 commit)
    // 注入错误:1/0 触发 SQL error(事务进入 aborted 状态)
    await expect(pool!.query('SELECT 1/0')).rejects.toThrow() // division_by_zero
    // 此时事务已 abort;任何后续语句会报 "current transaction is aborted";
    // 显式 ROLLBACK 回滚整个事务
    await pool!.query('ROLLBACK')
    const after = await counts()
    // ★ 回滚原子:edges 没删(DELETE 被 ROLLBACK 撤销),n1 仍在
    expect(after.n1).toBe(1)
    expect(after.n1Edges).toBe(2)
    expect(after.allEdges).toBe(3)
  })

  it('PG-T3 asset saga 跨介质边界:删 n1 + 减 asset a1 refcount 同事务;fault → 两边不动', async () => {
    await seed()
    const before = await counts()
    expect(before.n1).toBe(1)
    expect(before.a1Ref).toBe(1) // n1 引用 a1,refcount=1
    await pool!.query('BEGIN')
    await pool!.query('DELETE FROM n20_nodes WHERE id=$1', ['n1'])             // 删 node
    await pool!.query('UPDATE n20_assets SET refcount=refcount-1 WHERE id=$1', ['a1']) // 减 refcount
    // 注入错误(模拟 asset 服务端故障):CHECK 约束或 1/0
    await expect(pool!.query('SELECT 1/0')).rejects.toThrow()
    await pool!.query('ROLLBACK')
    const after = await counts()
    // ★ 跨表(等效跨介质)原子回滚:node 仍在 + asset refcount 仍 1(无 partial)
    expect(after.n1).toBe(1)
    expect(after.a1Ref).toBe(1)
  })

  it('PG-T4 对照:无事务时删 edges 后崩溃 → partial(证明事务必要性)', async () => {
    await seed()
    // 模拟"无事务":逐条删 edges(无 BEGIN/COMMIT 包裹),第二条前"故障"
    await pool!.query('DELETE FROM n20_edges WHERE id=$1', ['e1']) // e1 立即提交(无事务)
    // 此时若崩溃 → e1 已删但 e2 还在(partial,孤儿)
    const c = await counts()
    expect(c.allEdges).toBe(2) // e2,e3 仍在(e1 已 partial 删)
    expect(c.n1Edges).toBe(1)  // 只剩 e2 引用 n1 → 孤儿 edge 风险(无事务时存在)
    // ★ 证明:无事务时跨 record 操作有 partial 风险;N2-1 deleteNodeCascade 必须用 PG 事务(§10.4 strict-tx)
  })
})
