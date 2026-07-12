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
/**
 * R6 F2:真实 apply-with-idempotency path(判决 V4:原 PG-T6 首次手写事务,重连只 SELECT idem 不执行领域写,
 *   第二次根本未发起 mutation → 状态不变是必然结果,不能证明真实 replay early-return;也不能捕获"命中 idem
 *   后仍继续领域写"的实现错误)。取代 R5 的 withClientOn(只借 client 不做 hit/miss 分支)。
 * 同一 path 完成 hit/miss 分支 + 事务:
 *   - hit(SELECT idem row 命中)→ 返 cached result,不执行 mutation(early return)— 验收:移除此则第二次
 *     二次 bump revision/seq/event,断言"不变"必红。
 *   - miss → 单事务原子写领域(mutation)+ idem row;mutation 内 throw(fault seam,T6b 用)→ ROLLBACK,
 *     领域写 + idem row 都不落地(同事务原子,非另写一段 SQL)。
 */
type IdemResult = { resultKind: string; revision: number; seq: number }
async function applyWithIdempotency(
  target: Pool,
  key: string,
  mutation: (client: PoolClient) => Promise<IdemResult>,
): Promise<IdemResult & { deduped: boolean }> {
  // hit path:查 idem row,命中 → 返 cached,不执行 mutation(★ early return — 验收:移除此则测试必红)
  const cached = await target.query(
    'SELECT result_kind, revision::text AS revision, seq::text AS seq FROM n20_idempotency WHERE key=$1',
    [key],
  )
  if (cached.rows.length > 0) {
    return {
      resultKind: cached.rows[0].result_kind,
      revision: Number(cached.rows[0].revision),
      seq: Number(cached.rows[0].seq),
      deduped: true,
    }
  }
  // miss path:单事务原子写领域(mutation)+ idem result row;mutation 内 throw → ROLLBACK(idem row 不落地)
  const client = await target.connect()
  try {
    await client.query('BEGIN')
    const result = await mutation(client) // 领域写(可能 bump revision/seq/event);throw → 事务 abort
    await client.query(
      'INSERT INTO n20_idempotency(key,result_kind,revision,seq) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [key, result.resultKind, result.revision, result.seq],
    )
    await client.query('COMMIT')
    return { ...result, deduped: false }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
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

  it('PG-T6 idempotent replay 同一 apply path(R6 F2):applyWithIdempotency 同 key 两次调用 → 第二次命中 cached 不二次 bump revision/seq/event(非只测 ON CONFLICT;移除 early return 测试必红)', async () => {
    // R6 F2 红证(判决 V4):原 PG-T6 首次手写事务(189-196),重连(198-203)只 SELECT idem row 后测试代码直接不
    //   执行任何领域 SQL → 第二次根本未发起 mutation,revision/seq/event 不变是必然结果,不能证明真实 replay
    //   调用会 early-return,更不能捕获"命中 idem 后仍继续领域写"的实现错误。
    // 绿证(补探针把声称测实):抽出真实 applyWithIdempotency(target,key,mutation)— 同一 path 完成 hit/miss 分支 +
    //   事务;首次与重连均调用它;hit → 返 cached 不执行 mutation(early return);miss → 单事务原子写领域 + idem row。
    //   验收:移除 hit path early return(让 hit 也走 mutation)→ 第二次二次 bump revision/seq/event → 断言"不变"必红。
    await pool!.query('TRUNCATE n20_records, n20_canvas_seq, n20_events, n20_idempotency')
    await pool!.query("INSERT INTO n20_records(id,title,revision) VALUES ('n1','orig',0)")
    await pool!.query("INSERT INTO n20_canvas_seq(canvas_id,seq) VALUES ('c1',0)")
    const cfg = pgConn()
    // mutation:单事务原子写领域 record(bump revision)+ canvas seq(bump)+ event append + 读出 authoritative state
    const mutation = async (client: PoolClient): Promise<IdemResult> => {
      await client.query("UPDATE n20_records SET title='T1', revision=revision+1 WHERE id='n1'")
      await client.query("INSERT INTO n20_canvas_seq(canvas_id,seq) VALUES ('c1',1) ON CONFLICT (canvas_id) DO UPDATE SET seq = n20_canvas_seq.seq + 1")
      const seqRow = await client.query("SELECT seq::text AS seq FROM n20_canvas_seq WHERE canvas_id='c1'")
      const seq = Number(seqRow.rows[0].seq)
      await client.query("INSERT INTO n20_events(seq,record_id,op_id) VALUES ($1,'n1','idem-1')", [seq])
      const rec = await client.query("SELECT revision::text AS revision FROM n20_records WHERE id='n1'")
      return { resultKind: 'ok', revision: Number(rec.rows[0].revision), seq }
    }
    // ── 首次(poolA):applyWithIdempotency miss path → 单事务原子写领域 + idem row ──
    const poolA = new Pool(cfg)
    const first = await applyWithIdempotency(poolA, 'idem-1', mutation)
    expect(first.deduped).toBe(false)       // ★ 首次 miss(领域写 + idem row 落地)
    expect(first.resultKind).toBe('ok'); expect(first.revision).toBe(1); expect(first.seq).toBe(1)
    // 首次后 authoritative state:record revision=1 / canvas seq=1 / event count=1 / idem row=1
    expect((await poolA.query("SELECT revision::text AS r FROM n20_records WHERE id='n1'")).rows[0].r).toBe('1')
    expect((await poolA.query("SELECT seq::text AS s FROM n20_canvas_seq WHERE canvas_id='c1'")).rows[0].s).toBe('1')
    expect((await poolA.query('SELECT count(*)::int AS c FROM n20_events')).rows[0].c).toBe(1)
    expect((await poolA.query("SELECT count(*)::int AS c FROM n20_idempotency WHERE key='idem-1'")).rows[0].c).toBe(1)
    await poolA.end() // ★ 销毁 poolA(模拟进程重启;PG 表保留,非内存)
    // ── 重连(poolB):applyWithIdempotency 同 key 'idem-1' → hit path → 返 cached,不执行 mutation ──
    const poolB = new Pool(cfg)
    const second = await applyWithIdempotency(poolB, 'idem-1', mutation)
    expect(second.deduped).toBe(true)        // ★ hit(返 cached result,不二次 apply 领域写)
    expect(second.resultKind).toBe('ok'); expect(second.revision).toBe(1); expect(second.seq).toBe(1) // 与首次同结果
    // ★ authoritative state 全不变(replay 未二次 bump revision/seq/event,未二次 append event)
    const rec = await poolB.query("SELECT title, revision::text AS r FROM n20_records WHERE id='n1'")
    expect(rec.rows[0].title).toBe('T1'); expect(rec.rows[0].r).toBe('1')     // ★ 领域写值不变(replay 未二次 apply)
    expect((await poolB.query("SELECT seq::text AS s FROM n20_canvas_seq WHERE canvas_id='c1'")).rows[0].s).toBe('1') // ★ canvas seq 不变
    expect((await poolB.query('SELECT count(*)::int AS c FROM n20_events')).rows[0].c).toBe(1) // ★ event count 不变
    await poolB.end()
    // ★ R6 F2 验收:同 key 两次调用 applyWithIdempotency 返同首次结果;authoritative record revision / canvas seq /
    //   event count 全不变(真实领域 replay 幂等,非"测试没发起第二次 apply"的假象)。移除 hit path early return → 二次 bump → 断言红。
  })

  it('PG-T6b idempotent 首次事务 fault(R6 F2):applyWithIdempotency mutation 内 fault → 同事务 ROLLBACK(领域写+idem row 都不落地 → 重试可重做,非误判 dedup)', async () => {
    // R6 F2 红证(判决 V4):原 T6b 另写一段 SQL(withClient 手写 BEGIN/领域写/idem row/1/0/ROLLBACK),未走同一
    //   apply path — 判决要求"T6b 应通过同一函数的 fault seam 触发 rollback,而非另写一段 SQL"。
    // 绿证(补探针):T6b 复用 applyWithIdempotency 同一 path;fault seam = mutation 内 throw(SELECT 1/0)→
    //   applyWithIdempotency catch → ROLLBACK(领域写 + idem row 同事务原子不落地)→ 重试同 key 仍 miss(可重做)。
    await pool!.query('TRUNCATE n20_records, n20_canvas_seq, n20_events, n20_idempotency')
    await pool!.query("INSERT INTO n20_records(id,title,revision) VALUES ('n1','orig',0)")
    await pool!.query("INSERT INTO n20_canvas_seq(canvas_id,seq) VALUES ('c1',0)")
    // faultyMutation:写领域 + 注入 1/0 fault → throw → applyWithIdempotency ROLLBACK(同事务,非另写 SQL)
    const faultyMutation = async (client: PoolClient): Promise<IdemResult> => {
      await client.query("UPDATE n20_records SET title='broken', revision=revision+1 WHERE id='n1'") // 领域写(将被 rollback)
      await client.query("INSERT INTO n20_canvas_seq(canvas_id,seq) VALUES ('c1',1) ON CONFLICT (canvas_id) DO UPDATE SET seq = n20_canvas_seq.seq + 1")
      await client.query("INSERT INTO n20_events(seq,record_id,op_id) VALUES (1,'n1','idem-fault')") // event(将被 rollback)
      await client.query('SELECT 1/0') // ★ fault seam(division_by_zero)→ throw → 事务 abort → ROLLBACK
      return { resultKind: 'ok', revision: 0, seq: 0 } // 不可达(上面 throw);TS 需返回路径
    }
    // ★ 首次调用 fault → throw → ROLLBACK(领域写 + idem row 都不落地)
    await expect(applyWithIdempotency(pool!, 'idem-fault', faultyMutation)).rejects.toThrow()
    // ★ 同事务原子回滚:领域写未落地(title 仍 orig,revision 仍 0)+ canvas seq 仍 0 + event count 0 + idem row 未落地
    const rec = await pool!.query("SELECT title, revision::text AS r FROM n20_records WHERE id='n1'")
    expect(rec.rows[0].title).toBe('orig'); expect(rec.rows[0].r).toBe('0') // ★ 领域写未落地(rollback)
    expect((await pool!.query("SELECT seq::text AS s FROM n20_canvas_seq WHERE canvas_id='c1'")).rows[0].s).toBe('0')
    expect((await pool!.query('SELECT count(*)::int AS c FROM n20_events')).rows[0].c).toBe(0)
    expect((await pool!.query("SELECT count(*)::int AS c FROM n20_idempotency WHERE key='idem-fault'")).rows[0].c).toBe(0) // ★ idem row 不落地 → 重试不被误判 dedup
    // ★ 重试同 key:因 idem row 未落地 → miss path → 可重做领域写(非误判 dedup 永久丢)
    const goodMutation = async (client: PoolClient): Promise<IdemResult> => {
      await client.query("UPDATE n20_records SET title='recovered', revision=revision+1 WHERE id='n1'")
      await client.query("INSERT INTO n20_canvas_seq(canvas_id,seq) VALUES ('c1',1) ON CONFLICT (canvas_id) DO UPDATE SET seq = n20_canvas_seq.seq + 1")
      const seqRow = await client.query("SELECT seq::text AS seq FROM n20_canvas_seq WHERE canvas_id='c1'")
      const seq = Number(seqRow.rows[0].seq)
      await client.query("INSERT INTO n20_events(seq,record_id,op_id) VALUES ($1,'n1','idem-fault')", [seq])
      const r = await client.query("SELECT revision::text AS revision FROM n20_records WHERE id='n1'")
      return { resultKind: 'ok', revision: Number(r.rows[0].revision), seq }
    }
    const retry = await applyWithIdempotency(pool!, 'idem-fault', goodMutation)
    expect(retry.deduped).toBe(false)        // ★ 重做成功(idem row 未落地 → 重试 miss → 可重做)
    expect(retry.revision).toBe(1); expect(retry.seq).toBe(1)
    // ★ 再次同 key → hit → 返 cached(重做后 idem row 落地,replay 不再二次 apply)
    const replay = await applyWithIdempotency(pool!, 'idem-fault', goodMutation)
    expect(replay.deduped).toBe(true)
    expect((await pool!.query("SELECT revision::text AS r FROM n20_records WHERE id='n1'")).rows[0].r).toBe('1') // ★ 不变
    // ★ R6 F2 验收:首次事务 fault → 领域写 + idem row 同事务 ROLLBACK(idem row 不落地)→ 重试可重做非误判 dedup。
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
