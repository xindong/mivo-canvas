// scripts/e2e-persist-smoke.mjs
// A2-S4 Block 5: --persist=server 档 e2e harness 冒烟。
//
// 证明 BFF server 档连真 PG → 写入落 PG → 重载从 PG hydrate 校验(建画布→写入 node→GET 重载校验)。
// 纯 HTTP 打 BFF(不打前端/不启 Playwright),与 pg-suite 同款 PG service(本地 docker-compose.e2e.yml
// 起 PG / CI service container,对齐现有 pg suite 做法)。
//
// 本块交付 harness 能力(lead §4:不要求 A2 全部七条 SC 用例;SC 用例是后续块)。本脚本只证:
//  1. persist 维度透传落地:BFF server 档 /healthz 返 backend=pg durable=true(fail visibly:非 pg 即抛);
//  2. 写入落 PG + hydrate 从 PG 拉:POST project/canvas/node → GET canvas 重载校验 node 持久;
//  3. 测试数据清理:reset 清 PG 残留,reset 后 GET canvas → 404(不留残留污染下一轮)。
//
// F4: finally 受保护兜底 reset。早期断言失败(如 ④ 建 node 500)会跳过 ⑥ reset → PG 残留污染下一轮;
//   finally 跟踪 serverReady/cleanupDone,BFF 起成功但 cleanup 没做时兜底 reset。清理失败与原始测试错误
//   分别保留聚合上报(不互相吞——原始错误在前,清理错误在后,throw 聚合 Error)。
//
// 鉴权(legacy 模式,e2e 不设 MIVO_SSO_STRICT → createSsoStrictProofGate no-op;assertStrictOwnerMigrationComplete
// 仅 strict 跑,e2e no-op):BFF env MIVO_PLATFORM_KEY=mivo_e2e_persist → resolveActor = fingerprintOfPlatformKey(key)
// 稳定 owner;请求带 X-Mivo-Api-Key: mivo_e2e_persist(合法 mivo_ 前缀,过 rejectInvalidMivoApiKey)→
// owner===actor 自归属过 authz。raw key 永不落库(只指纹)。
import { randomUUID } from 'node:crypto'
import {
  createBaseUrl,
  resetServerPersist,
  runCommand,
  startSmokeBffServer,
  stopSmokeDevServer,
} from './e2e/harness.mjs'
import { prepareSmokeFixtures } from './e2e/fixtures.mjs'
import { waitForServer } from './e2e-helpers.mjs'

const requestedPort = Number(process.env.MIVO_E2E_PORT ?? 5174)
const baseUrl = createBaseUrl(requestedPort)
const resetToken = process.env.MIVO_E2E_RESET_TOKEN ?? 'e2e-reset-token'
const platformKey = process.env.MIVO_PLATFORM_KEY ?? 'mivo_e2e_persist'

// persist 路由鉴权 header:X-Mivo-Api-Key(合法 mivo_ 前缀)+ content-type。
// rejectInvalidMivoApiKey 对合法 mivo_ 前缀放行;resolveActor legacy = fingerprintOfPlatformKey(key)。
const authHeaders = { 'x-mivo-api-key': platformKey, 'content-type': 'application/json' }

// canonical NodeRecord wire payload(Omit id/revision;满足 validateChildPayload 白名单 schema:
// required type/title/transform/fills/strokes/effects/relations 全齐;fills[0] 满足 FILL_ELEMENT solid
// variant;无 PAYLOAD_MIRROR_FIELDS/forbidden status/tasks)。persistTestApp.canonicalNode 的内联副本。
const canonicalNodePayload = {
  type: 'image',
  title: 'e2e-persist-node',
  transform: { x: 10, y: 20, width: 100, height: 100, rotation: 0 },
  fills: [{ id: 'f1', kind: 'solid', color: '#ffffff', opacity: 1, visible: true }],
  strokes: [],
  effects: [],
  relations: {},
}

const { localAssetFixtureDir } = prepareSmokeFixtures()

let server
// F4: 状态跟踪(serverReady=BFF 起成功可 reset;cleanupDone=reset 已成功)。finally 据此决定是否兜底 reset。
let serverReady = false
let cleanupDone = false
const errors = [] // 聚合错误(原始测试错误在前,清理错误在后;不互相吞)。

try {
  await runCommand('npm', ['run', 'verify:logging'])
  server = startSmokeBffServer({
    port: requestedPort,
    localAssetFixtureDir,
    eagleMockPort: 0,
    upstreamBaseUrl: null,
    debugViewToken: '',
    enableLocalAssets: false,
    enableEagleProxy: false,
    isPublic: false,
    persistMode: 'server',
  })
  await waitForServer(`${baseUrl}/healthz`)
  serverReady = true // BFF 起成功 → finally 可兜底 reset

  // ── ① persist 维度透传落地校验(fail visibly:server 档必须是 PG durable)──
  const healthRes = await fetch(`${baseUrl}/healthz`)
  const health = await healthRes.json()
  if (health.persist?.backend !== 'pg' || health.persist?.durable !== true) {
    throw new Error(
      `server 档 BFF 必须连真 PG,但 /healthz 返 persist=${JSON.stringify(health.persist)}` +
      `(期望 backend=pg durable=true)。检查 MIVO_PERSIST_BACKEND=pg + MIVO_PG_PASSWORD + PG service 是否就绪。`,
    )
  }
  console.log(`[e2e-persist-smoke] ① BFF server 档就绪:persist=${health.persist.backend} durable=${health.persist.durable}`)

  // ── ② 建 project(POST /api/projects;幂等 id)──
  const projectId = `e2e-proj-${randomUUID().slice(0, 8)}`
  const projRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ id: projectId, name: 'e2e-persist-smoke' }),
  })
  if (projRes.status !== 201) {
    throw new Error(`建 project 失败:HTTP ${projRes.status} ${await projRes.text()}`)
  }
  const projBody = await projRes.json()
  if (projBody.id !== projectId) {
    throw new Error(`project id 不匹配:期望 ${projectId} 实得 ${projBody.id}`)
  }
  console.log(`[e2e-persist-smoke] ② project 建成 id=${projectId}`)

  // ── ③ 建 canvas(POST /api/canvas;createCanvasWithCollection 原子建 canvas meta + chat-collection)──
  const canvasId = `e2e-canvas-${randomUUID().slice(0, 8)}`
  const canvasRes = await fetch(`${baseUrl}/api/canvas`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ id: canvasId, projectId, title: 'e2e-persist-canvas' }),
  })
  if (canvasRes.status !== 201) {
    throw new Error(`建 canvas 失败:HTTP ${canvasRes.status} ${await canvasRes.text()}`)
  }
  const canvasBody = await canvasRes.json()
  if (canvasBody.id !== canvasId) {
    throw new Error(`canvas id 不匹配:期望 ${canvasId} 实得 ${canvasBody.id}`)
  }
  console.log(`[e2e-persist-smoke] ③ canvas 建成 id=${canvasId} metaRevision=${canvasBody.metaRevision}`)

  // ── ④ 写入 node(POST /api/canvas/:id/nodes/:nodeId;CreateBody {clientId,type,payload})──
  // 响应 CanvasChildUpsertResponse {id,revision,seq,base}——seq+base 是 A2-S2/S3 签发的 BaseCursor。
  const nodeId = `e2e-node-${randomUUID().slice(0, 8)}`
  const nodeRes = await fetch(`${baseUrl}/api/canvas/${canvasId}/nodes/${nodeId}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ clientId: nodeId, type: 'node', payload: canonicalNodePayload }),
  })
  if (nodeRes.status !== 201) {
    throw new Error(`建 node 失败:HTTP ${nodeRes.status} ${await nodeRes.text()}`)
  }
  const nodeBody = await nodeRes.json()
  if (nodeBody.id !== nodeId) {
    throw new Error(`node 写响应 id 不匹配:期望 ${nodeId} 实得 ${nodeBody.id}`)
  }
  if (typeof nodeBody.revision !== 'number' || typeof nodeBody.seq !== 'number' || typeof nodeBody.base !== 'string') {
    throw new Error(`node 写响应缺 seq/base(CanvasChildUpsertResponse):${JSON.stringify(nodeBody)}`)
  }
  console.log(`[e2e-persist-smoke] ④ node 写入 id=${nodeId} revision=${nodeBody.revision} seq=${nodeBody.seq}`)

  // ── ⑤ 重载 hydrate 校验(GET /api/canvas/:id → GetCanvasResponse {nodes:[{id,revision,...}]})──
  // 这是核心断言:写入的 node 从 PG 重载(hydrate 从 BFF 拉,非 IDB)。证明 persist server 档全链路打通。
  const hydrateRes = await fetch(`${baseUrl}/api/canvas/${canvasId}`, { headers: authHeaders })
  if (hydrateRes.status !== 200) {
    throw new Error(`hydrate GET canvas 失败:HTTP ${hydrateRes.status} ${await hydrateRes.text()}`)
  }
  const hydrateBody = await hydrateRes.json()
  const found = (hydrateBody.nodes ?? []).find((n) => n.id === nodeId)
  if (!found) {
    throw new Error(
      `hydrate 未找到写入的 node ${nodeId};nodes=${JSON.stringify((hydrateBody.nodes ?? []).map((n) => n.id))}`,
    )
  }
  if (found.revision !== nodeBody.revision) {
    throw new Error(`hydrate node revision 不匹配:期望 ${nodeBody.revision} 实得 ${found.revision}`)
  }
  console.log(`[e2e-persist-smoke] ⑤ hydrate 校验通过:node ${nodeId} revision=${found.revision} 从 PG 重载`)

  // ── ⑥ 测试数据清理:reset 清空 PG(不留残留污染下一轮)──
  // resetServerPersist 调 POST /api/__e2e/reset(server 档三重保险已挂载);成功设 cleanupDone=true。
  const resetResult = await resetServerPersist(baseUrl, resetToken)
  if (!resetResult.ok) {
    throw new Error(`server 档 reset 未成功:${resetResult.reason}`)
  }
  cleanupDone = true
  console.log(`[e2e-persist-smoke] ⑥ PG 清理完成 backend=${resetResult.backend ?? 'pg'}`)

  // ── ⑦ reset 无残留校验:GET /api/canvas/:id → 404 unknown-canvas(证明清空,不污染下一轮)──
  const afterResetRes = await fetch(`${baseUrl}/api/canvas/${canvasId}`, { headers: authHeaders })
  if (afterResetRes.status !== 404) {
    throw new Error(
      `reset 后 canvas 应 404 unknown-canvas,实得 HTTP ${afterResetRes.status}(残留污染下一轮风险)`,
    )
  }
  console.log(`[e2e-persist-smoke] ⑦ reset 无残留校验通过:canvas ${canvasId} 已 404`)

  console.log('E2E persist server smoke passed')
} catch (err) {
  // F4: 原始测试错误在前(不吞);清理错误(若 finally 兜底失败)在后。聚合上报。
  errors.push(err)
} finally {
  // F4: 受保护兜底 reset。BFF 起成功(serverReady)但 cleanup 没做(早期断言失败跳过 ⑥)→ finally 兜底,
  //   防 PG 残留污染下一轮。清理失败不吞原始错误(分别 push,聚合 throw)。
  if (serverReady && !cleanupDone) {
    try {
      const r = await resetServerPersist(baseUrl, resetToken)
      if (r.ok) {
        cleanupDone = true
        console.log('[e2e-persist-smoke] F4 finally 兜底 reset 成功(早期断言失败后清 PG 残留)')
      } else {
        errors.push(new Error(`F4 finally 兜底 reset 未成功:${r.reason}`))
      }
    } catch (cleanupErr) {
      errors.push(new Error(`F4 finally 兜底 reset 失败:${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`))
    }
  }
  await stopSmokeDevServer(server)
}

// F4: 聚合上报。errors 非空 → throw 聚合 Error(原始测试错误 + 清理错误分别保留,不互相吞)。
if (errors.length > 0) {
  const messages = errors.map((e, i) => `  [${i + 1}] ${e instanceof Error ? e.message : String(e)}`).join('\n')
  throw new Error(`e2e-persist-smoke 失败(聚合 ${errors.length} 个错误,原始测试错误在前 + 清理错误在后,不互相吞):\n${messages}`)
}
