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
  // 建专用临时表(不依赖 mivo schema);R3 F2 加 field_clock/idempotency/records(PG-T5/T6/T7);
  //   R5 F2:n20_records 加 revision 列 + 新增 n20_canvas_seq/n20_events(PG-T6 真实领域 replay path 用)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS n20_nodes (id text PRIMARY KEY, title text, asset_id text);
    CREATE TABLE IF NOT EXISTS n20_edges (id text PRIMARY KEY, from_id text NOT NULL, to_id text NOT NULL);
    CREATE TABLE IF NOT EXISTS n20_assets (id text PRIMARY KEY, refcount integer NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS n20_field_clock (canvas_id text NOT NULL, record_id text NOT NULL, field_key text NOT NULL, clock bigint NOT NULL DEFAULT 0, PRIMARY KEY (canvas_id, record_id, field_key));
    CREATE TABLE IF NOT EXISTS n20_idempotency (key text PRIMARY KEY, result_kind text NOT NULL, revision bigint NOT NULL, seq bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS n20_records (id text PRIMARY KEY, title text NOT NULL, revision bigint NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS n20_canvas_seq (canvas_id text PRIMARY KEY, seq bigint NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS n20_events (seq bigint PRIMARY KEY, record_id text NOT NULL, op_id text NOT NULL);
  `)
})

afterAll(async () => {
  if (!pool) return
  await pool.query('DROP TABLE IF EXISTS n20_nodes; DROP TABLE IF EXISTS n20_edges; DROP TABLE IF EXISTS n20_assets; DROP TABLE IF EXISTS n20_field_clock; DROP TABLE IF EXISTS n20_idempotency; DROP TABLE IF EXISTS n20_records; DROP TABLE IF EXISTS n20_canvas_seq; DROP TABLE IF EXISTS n20_events;')
  await pool.end()
})

/** R2-1:借专用 client + finally release,保证 BEGIN/DELETE/COMMIT 在同一连接上执行(事务性)。 */
async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool!.connect()
  try { return await fn(client) } finally { client.release() }
}
/** R5 F2:在指定 pool(非全局 pool)上借专用 client + finally release(PG-T6 跨 pool 重连 replay 用)。 */
async function withClientOn<T>(target: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await target.connect()
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

  it('PG-T5 field_clock 持久(R3 F2):write clock → 销毁 pool → 重连读回;重启可恢复(非 S10-4 内存 Map 模拟)', async () => {
    // R3 F2 红证:S10-4 只把 DDL 放字符串 + persistedRows 数组模拟重启(内存,destroy 即丢,不证持久);
    //   绿证:本探针真 PG — write via poolA → end poolA(模拟进程重启)→ read via fresh poolB → clock 仍在。
    await pool!.query('TRUNCATE n20_field_clock')
    const cfg = pgConn()
    const poolA = new Pool(cfg)
    await poolA.query("INSERT INTO n20_field_clock(canvas_id,record_id,field_key,clock) VALUES ('c1','n1','title',3),('c1','n1','transform.x',1) ON CONFLICT DO NOTHING")
    await poolA.end() // ★ 销毁 poolA(模拟进程重启;内存 Map 会丢,PG 表保留)
    const poolB = new Pool(cfg) // ★ 重连(新 pool,非内存)
    const res = await poolB.query("SELECT field_key, clock::text AS clock FROM n20_field_clock WHERE record_id='n1' ORDER BY field_key")
    await poolB.end()
    expect(res.rows).toEqual([
      { field_key: 'title', clock: '3' },
      { field_key: 'transform.x', clock: '1' },
    ]) // ★ 重启后 clock 仍在(非内存,PG 持久;S10-4 内存模拟不证此)
  })

  it('PG-T6 idempotent replay 真实领域 path(R5 F2):单事务原子写领域 record+seq+event+idem row → 销毁 pool → 重连 replay 同 key → 不二次 bump revision/seq/event(非只测 ON CONFLICT)', async () => {
    // R5 F2 红证:原 PG-T6 只向 n20_idempotency 插字面量 (revision=2,seq=5)+ ON CONFLICT DO NOTHING,
    //   未执行领域写、authoritative revision/seq bump 或 event append;只能证 idem row 持久 + 唯一键冲突,
    //   不能证"同 key replay 不二次应用领域写 / 不二次 bump revision/seq / 不二次发事件"(文档声称强于实测)。
    // 绿证(补探针把声称测实):本探针单 PG 事务原子写(领域 record title+revision / canvas seq / event / idem result row),
    //   销毁 pool 模拟进程重启 → 重连走真实 replay path(SELECT idem → 命中 cached → 不二次 apply)→
    //   断言 authoritative record revision / canvas seq / event count 与首次结果均不变。
    await pool!.query('TRUNCATE n20_records, n20_canvas_seq, n20_events, n20_idempotency')
    await pool!.query("INSERT INTO n20_records(id,title,revision) VALUES ('n1','orig',0)")
    await pool!.query("INSERT INTO n20_canvas_seq(canvas_id,seq) VALUES ('c1',0)")
    const cfg = pgConn()
    // ── 首次事务(poolA):单事务原子写领域 record + bump revision + bump canvas seq + append event + insert idem row ──
    const poolA = new Pool(cfg)
    await withClientOn(poolA, async (client) => {
      await client.query('BEGIN')
      await client.query("UPDATE n20_records SET title='T1', revision=revision+1 WHERE id='n1'") // 领域写 + revision bump 0→1
      await client.query("INSERT INTO n20_canvas_seq(canvas_id,seq) VALUES ('c1',1) ON CONFLICT (canvas_id) DO UPDATE SET seq = n20_canvas_seq.seq + 1") // canvas seq 0→1
      await client.query("INSERT INTO n20_events(seq,record_id,op_id) VALUES (1,'n1','idem-1')") // append event(count=1)
      await client.query("INSERT INTO n20_idempotency(key,result_kind,revision,seq) VALUES ('idem-1','ok',1,1) ON CONFLICT DO NOTHING") // idem result row
      await client.query('COMMIT')
    })
    await poolA.end() // ★ 销毁 poolA(模拟进程重启;内存 Map 会丢,PG 表保留)
    // ── 重连(poolB)走真实 replay path:同 key 'idem-1' → SELECT idem → 命中 cached → 不二次 apply ──
    const poolB = new Pool(cfg)
    const cached = await poolB.query("SELECT result_kind, revision::text AS revision, seq::text AS seq FROM n20_idempotency WHERE key='idem-1'")
    expect(cached.rows.length).toBe(1) // ★ 命中缓存(replay 返首次结果,不二次 apply 领域写)
    expect(cached.rows[0].result_kind).toBe('ok'); expect(cached.rows[0].revision).toBe('1'); expect(cached.rows[0].seq).toBe('1')
    // ★ replay 不再执行领域写 / bump seq / append event(返 cached result 即止)— 断言权威领域 state 不变:
    const rec = await poolB.query("SELECT title, revision::text AS revision FROM n20_records WHERE id='n1'")
    expect(rec.rows[0].title).toBe('T1')     // ★ 领域写值不变(replay 未二次 apply 改写)
    expect(rec.rows[0].revision).toBe('1')   // ★ authoritative revision 不变(未二次 bump 到 2)
    const seqRow = await poolB.query("SELECT seq::text AS seq FROM n20_canvas_seq WHERE canvas_id='c1'")
    expect(seqRow.rows[0].seq).toBe('1')     // ★ canvas seq 不变(未二次 bump 到 2)
    const evtCount = await poolB.query('SELECT count(*)::int AS c FROM n20_events')
    expect(evtCount.rows[0].c).toBe(1)       // ★ event count 不变(replay 未二次 append event)
    await poolB.end()
    // ★ R5 F2 验收:replay 前后 authoritative record revision / canvas seq / event count 全不变(真实领域 replay 幂等,非只 ON CONFLICT)。
  })

  it('PG-T6b idempotent 首次事务 fault(R5 F2):领域写 + idem row 同事务 fault → 一起 ROLLBACK(无 partial;idem row 不落地 → 重试可重做)', async () => {
    // R5 F2:replay 幂等的前提是"首次事务 fault 时领域写与 idem row 一起 rollback";否则 idem row 落了但领域写没成
    //   → 重试被误判 dedup → 永久丢领域写。本探针证同事务 fault → 两边一起 ROLLBACK(idem row 不落地,重试可重做)。
    await pool!.query('TRUNCATE n20_records, n20_canvas_seq, n20_events, n20_idempotency')
    await pool!.query("INSERT INTO n20_records(id,title,revision) VALUES ('n1','orig',0)")
    await pool!.query("INSERT INTO n20_canvas_seq(canvas_id,seq) VALUES ('c1',0)")
    await withClient(async (client) => {
      await client.query('BEGIN')
      await client.query("UPDATE n20_records SET title='broken', revision=revision+1 WHERE id='n1'") // 领域写
      await client.query("INSERT INTO n20_idempotency(key,result_kind,revision,seq) VALUES ('idem-fault','ok',1,1) ON CONFLICT DO NOTHING") // idem row
      await expect(client.query('SELECT 1/0')).rejects.toThrow() // fault(division_by_zero)→ 事务 abort
      await client.query('ROLLBACK')
    })
    // ★ 领域写回滚(title 仍 orig,revision 仍 0)+ idem row 回滚(未落地 → 重试不被误判 dedup)
    const rec = await pool!.query("SELECT title, revision::text AS revision FROM n20_records WHERE id='n1'")
    expect(rec.rows[0].title).toBe('orig')
    expect(rec.rows[0].revision).toBe('0') // ★ 领域写未落地(rollback)
    const idem = await pool!.query("SELECT count(*)::int AS c FROM n20_idempotency WHERE key='idem-fault'")
    expect(idem.rows[0].c).toBe(0) // ★ idem row 未落地 → 重试可重做领域写(非误判 dedup 永久丢)
  })

  it('PG-T7 strict-tx 跨 record 单事务(R3 F2):BEGIN 两不同 record + fault + ROLLBACK → 两 record 均不变(非 S10-5 单 record)', async () => {
    // R3 F2 红证:S10-5 始终 clone/commit ops[0].recordId(单 record),不能证 §10.4 跨 record 单事务原子;
    //   绿证:本探针两不同 record(nA/nB)同一 client BEGIN + 双 update + fault + ROLLBACK → 两 record 均不变。
    await pool!.query('TRUNCATE n20_records')
    await pool!.query("INSERT INTO n20_records(id,title) VALUES ('nA','origA'),('nB','origB')")
    await withClient(async (client) => {
      await client.query('BEGIN')
      await client.query("UPDATE n20_records SET title='newA' WHERE id='nA'") // record A
      await client.query("UPDATE n20_records SET title='newB' WHERE id='nB'") // record B(不同 record)
      await expect(client.query('SELECT 1/0')).rejects.toThrow() // fault(division_by_zero)
      await client.query('ROLLBACK')
    })
    const a = await pool!.query("SELECT title FROM n20_records WHERE id='nA'")
    const b = await pool!.query("SELECT title FROM n20_records WHERE id='nB'")
    expect(a.rows[0].title).toBe('origA') // ★ A 未改
    expect(b.rows[0].title).toBe('origB') // ★ B 未改(跨 record 同事务原子回滚,非 partial;S10-5 单 record 不证此)
  })
})
