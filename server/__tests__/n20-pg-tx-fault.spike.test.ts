// server/__tests__/n20-pg-tx-fault.spike.test.ts
// N2-0 返修 Gate3 PG 侧(R2-1):真实 PG transaction fault injection + 同库资产元数据边界。
//
// ★ spike 属性:N2-0 决策证据,证明 Figma 式 server-side 事务路径在同库 record/资产元数据边界可原子回滚。
//   gate:MIVO_PG_TEST=1(本地 brew PG port 55443,独立 DB mivocanvas_unit);CI 无 PG 跳过(describe.skipIf)。
//   用专用 n20_* 临时表(不依赖 mivo schema migrations),raw SQL 建模 N2-1 deleteNodeCascade 契约。
//
// R2-1 返修(本轮):
//   - 全部 PG-T 改 **同一 client**(pool.connect + finally release)保证 BEGIN/DELETE/COMMIT 在同一连接
//     上执行(原 pool.query 每次独立借还连接,事务性靠运气;pool max>1 时 BEGIN 在连接 A、COMMIT 在连接 B = 不在事务里)。
//   - PG-T3 改名"同库资产元数据"(原"asset saga 跨介质"名不副实:n20_nodes + n20_assets 是同库两表,非跨介质)。
//   - 真跨介质(PG + 文件系统/对象存储)非本探针范围 — Figma 式跨介质靠 saga 补偿(非真原子);Yjs 无跨介质方案。
//     Gate3 据此重评"平局"(intra 原子两案一致;跨介质 Figma=saga 鯓取非真原子、Yjs=无方案),见决策文档 §2 Gate3。
//
// 证明维度:
//   1. 原子提交(同一 client):BEGIN; 删 node + 级联删 edges;COMMIT → node + edges 全删。
//   2. fault injection(同一 client):BEGIN; 删 edges; 注入 SQL 错误;ROLLBACK → node + edges 全在(无 partial,回滚原子)。
//   3. 同库资产元数据(同一 client,非跨介质):删 node + 减 asset refcount 同事务;fault → rollback 两边不动。
//   对照真实 Yjs:Yjs intra-doc transact 原子(G3-real-1),但跨 Y.Doc/跨文件资产 = 非原子(G3-real-3);
//   PG server-side 事务可跨表(等效同库 record+资产元数据)原子回滚 — intra-doc/intra-DB 原子两案平局(见决策文档)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool, type PoolClient } from 'pg'

const PG_TEST_ENABLED = process.env.MIVO_PG_TEST === '1'

const pgConn = () => ({
  host: process.env.MIVO_PG_HOST || '127.0.0.1',
  port: Number(process.env.MIVO_PG_PORT || 55443),
  database: process.env.MIVO_PG_UNIT_DB || 'mivocanvas_unit',
  user: process.env.MIVO_PG_USER || 'mivo',
  password: process.env.MIVO_PG_PASSWORD || 'mivo-test-no-password',
  max: 5, // ★ R2-1:pool max>1,验证同一 client 事务性(并发占用其他连接时不影响 BEGIN/COMMIT 同连接)
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

/** R2-1:借专用 client + finally release,保证 BEGIN/DELETE/COMMIT 在同一连接上执行(事务性)。 */
async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool!.connect()
  try { return await fn(client) } finally { client.release() }
}

describe.skipIf(!PG_TEST_ENABLED)('N2-0 返修 Gate3 PG 侧(R2-1 同一 client): 真实事务原子提交 + fault injection 回滚 + 同库资产元数据', () => {
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

  it('PG-T1 原子提交(同一 client):BEGIN 删 n1+级联 edges + COMMIT → n1 与其 edges 全删,e3 保留', async () => {
    await seed()
    expect((await counts()).allEdges).toBe(3)
    // ★ R2-1:同一 client 上 BEGIN/DELETE/COMMIT(pool.connect + finally release,非 pool.query 独立借还)
    await withClient(async (client) => {
      await client.query('BEGIN')
      await client.query('DELETE FROM n20_edges WHERE from_id=$1 OR to_id=$1', ['n1']) // 删 e1,e2
      await client.query('DELETE FROM n20_nodes WHERE id=$1', ['n1'])                   // 删 n1
      await client.query('COMMIT')
    })
    const c = await counts()
    expect(c.n1).toBe(0)        // ★ n1 删
    expect(c.n1Edges).toBe(0)   // ★ 引用 n1 的 edges 全删(同一 client 事务原子)
    expect(c.allEdges).toBe(1)  // e3 保留(n2→n2)
  })

  it('PG-T2 fault injection(同一 client):BEGIN 删 edges + 注入错误 + ROLLBACK → n1 与 edges 全在(无 partial)', async () => {
    await seed()
    const before = await counts()
    expect(before.n1).toBe(1)
    expect(before.n1Edges).toBe(2) // e1,e2
    // ★ R2-1:同一 client 上 BEGIN/DELETE/fault/ROLLBACK(事务边界在同一连接)
    await withClient(async (client) => {
      await client.query('BEGIN')
      await client.query('DELETE FROM n20_edges WHERE from_id=$1 OR to_id=$1', ['n1']) // 删了 edges(未 commit)
      // 注入错误:1/0 触发 SQL error(事务进入 aborted 状态)
      await expect(client.query('SELECT 1/0')).rejects.toThrow() // division_by_zero
      // 此时事务已 abort;显式 ROLLBACK 回滚整个事务
      await client.query('ROLLBACK')
    })
    const after = await counts()
    // ★ 回滚原子:edges 没删(DELETE 被 ROLLBACK 撤销),n1 仍在
    expect(after.n1).toBe(1)
    expect(after.n1Edges).toBe(2)
    expect(after.allEdges).toBe(3)
  })

  it('PG-T3 同库资产元数据(同一 client,非跨介质):删 n1 + 减 asset a1 refcount 同事务;fault → 两边不动', async () => {
    await seed()
    const before = await counts()
    expect(before.n1).toBe(1)
    expect(before.a1Ref).toBe(1) // n1 引用 a1,refcount=1
    // ★ R2-1:同一 client 上 BEGIN/DELETE node + UPDATE asset refcount/fault/ROLLBACK
    //   注(R2-1):此为**同库两表**(n20_nodes + n20_assets),非"跨介质"(跨介质 = PG + 文件系统/对象存储);
    //   真跨介质 Figma 靠 saga 补偿(非真原子),Yjs 无方案 — Gate3 据此重评平局,见决策文档 §2 Gate3。
    await withClient(async (client) => {
      await client.query('BEGIN')
      await client.query('DELETE FROM n20_nodes WHERE id=$1', ['n1'])             // 删 node
      await client.query('UPDATE n20_assets SET refcount=refcount-1 WHERE id=$1', ['a1']) // 减 refcount
      // 注入错误(模拟 fault):1/0
      await expect(client.query('SELECT 1/0')).rejects.toThrow()
      await client.query('ROLLBACK')
    })
    const after = await counts()
    // ★ 同库两表原子回滚:node 仍在 + asset refcount 仍 1(无 partial)
    expect(after.n1).toBe(1)
    expect(after.a1Ref).toBe(1)
  })

  it('PG-T4 对照:无事务时删 edges 后崩溃 → partial(证明事务必要性)', async () => {
    await seed()
    // 模拟"无事务":逐条删 edges(无 BEGIN/COMMIT 包裹,同一 client 也不行),第二条前"故障"
    await pool!.query('DELETE FROM n20_edges WHERE id=$1', ['e1']) // e1 立即提交(无事务,pool.query 即时 commit)
    // 此时若崩溃 → e1 已删但 e2 还在(partial,孤儿)
    const c = await counts()
    expect(c.allEdges).toBe(2) // e2,e3 仍在(e1 已 partial 删)
    expect(c.n1Edges).toBe(1)  // 只剩 e2 引用 n1 → 孤儿 edge 风险(无事务时存在)
    // ★ 证明:无事务时跨 record 操作有 partial 风险;N2-1 deleteNodeCascade 必须用 PG 事务(§10.4 strict-tx)
  })
})
