import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { chromium } from 'playwright'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { projectRoot } from './bench/fixture-lib.mjs'

/**
 * 视觉 diff harness(Leafer 接入 PR-1 / Phase 0a 工装)。
 *
 * 固定场景、固定 DPR、禁动画(prefers-reduced-motion + 禁 transition),
 * 生成 baseline + candidate 截图 + diff 百分比 + diff artifact。
 *
 * 默认 DOM-vs-DOM 自检:同场景两次截图,diff 应 = 0%。
 *
 * 用法:
 *   node scripts/visual-diff.mjs                         # DOM vs DOM 自检
 *   node scripts/visual-diff.mjs --candidate=leafer      # DOM baseline vs leafer candidate(占位)
 *   node scripts/visual-diff.mjs --dpr=2                 # 固定 DPR=2
 *   node scripts/visual-diff.mjs --port=4180             # 自定义 dev 端口
 *   node scripts/visual-diff.mjs --candidate=leafer --fixture=rotation
 *       # FU-8 旋转对照:注入旋转 image/rect/ellipse/note/line/arrow + connector
 *       # 固定文档(bench 同款 replaceSnapshot 注入),DOM vs Leafer 像素对照
 *   node scripts/visual-diff.mjs --candidate=leafer --fixture=brush-stamp
 *   node scripts/visual-diff.mjs --candidate=leafer --fixture=markup-text
 *       # Phase 4c 对照:marker/highlighter/dashed/旋转 brush + stamp(含旋转)
 *       # + FU-10 半透明描边 rect/ellipse,DOM vs Leafer 像素对照
 *
 * Shell(外壳 UI)基线(T0.8):--fixture=shell-<name> 覆盖画布 shell 之外的 UI
 * 表面。沿用同一套机制(store 注入 + 禁动画 + pixelmatch + 同命名/输出约定),
 * 差异仅:setup 用 Playwright 触发瞬时态(菜单/弹窗/改名),按 descriptor 截
 * 指定元素或整视口;时间敏感项(侧栏相对时间、更新日志 7 天窗口)冻结 Date。
 * shell fixture 一律起 BFF(dev 双进程拓扑),输出 test-artifacts/visual-diff-shell-<name>。
 */

const DEFAULT_PORT = 4179
const DEFAULT_DPR = 1
const DIFF_THRESHOLD_PERCENT = 5.0

// T0.8 shell fixtures run against the project's canonical dual-process topology
// (Vite dev server + BFF). The BFF is started on a non-default port to avoid
// clashing with a developer's own 8080; Vite proxies /api to it via MIVO_BFF_DEV_URL.
const BFF_PORT = 8089
const BFF_ASSET_DIR = `${projectRoot}/public/demo-assets`

// Freeze the wall clock for time-sensitive shell UI. changelog.json's latest
// entry is 2026-07-09 (updatedAt 2026-07-09T20:03:05+08:00); freezing to this
// evening keeps it inside the 7-day window AND keeps formatSidebarTime relative
// labels deterministic. Only `new Date()` (no-arg) + `Date.now()` are frozen —
// `new Date(ms)` / `new Date(iso)` still resolve against the real Date engine.
const FROZEN_NOW_ISO = '2026-07-09T22:00:00+08:00'

const DEFAULT_BROWSER_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const DISABLE_ANIMATIONS_CSS = [
  '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}',
  'html,body{caret-color:transparent!important;}',
].join('')

const parseArgs = (argv) => {
  const options = {
    baseline: 'dom',
    candidate: 'dom',
    dpr: DEFAULT_DPR,
    port: DEFAULT_PORT,
    headless: true,
    outputDir: 'test-artifacts/visual-diff',
    fixture: null,
    textPaint: null,
    outputExplicit: false,
  }
  for (const entry of argv) {
    if (entry.startsWith('--baseline=')) options.baseline = entry.slice('--baseline='.length) || 'dom'
    else if (entry.startsWith('--candidate=')) options.candidate = entry.slice('--candidate='.length) || 'dom'
    else if (entry.startsWith('--fixture=')) options.fixture = entry.slice('--fixture='.length) || null
    else if (entry === '--text-paint=leafer') options.textPaint = 'leafer'
    else if (entry.startsWith('--dpr=')) {
      const dpr = Number.parseInt(entry.slice('--dpr='.length), 10)
      if (Number.isFinite(dpr) && dpr > 0) options.dpr = dpr
    } else if (entry.startsWith('--port=')) {
      const port = Number.parseInt(entry.slice('--port='.length), 10)
      if (Number.isFinite(port) && port > 0) options.port = port
    } else if (entry.startsWith('--output=')) {
      options.outputDir = entry.slice('--output='.length) || options.outputDir
      options.outputExplicit = true
    } else if (entry === '--headed') options.headless = false
  }
  return options
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForServer = async (url, timeoutMs = 60000, expectedStatus) => {
  const startedAt = Date.now()
  let lastError = new Error('Timed out waiting for dev server')
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
          response.resume()
          // P1-2: 原 statusCode < 500 把 404/401 残留错误进程当健康(端口起来但路由错/鉴权挂),
          // gate 误判通过。收紧到 2xx(BFF /api/mivo/local-assets 与 Vite 根都返回 200);
          // expectedStatus 传具体状态码时改为精确匹配,留例外口子。
          const code = response.statusCode
          const ok = typeof expectedStatus === 'number'
            ? code === expectedStatus
            : code >= 200 && code < 300
          ok ? resolve() : reject(new Error(`HTTP ${code}`))
        })
        request.on('error', reject)
      })
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await sleep(500)
    }
  }
  throw lastError
}

/**
 * 把信号发给 child 所在的整个 process group(detached:true 时 child.pid == pgid),
 * 一次性杀掉 npm + vite + 所有后代。仅 server.kill() 只杀 npm 直系子进程,vite 作为
 * 孙进程会被 reparent 到 init 继续存活,且它继承了 stdio pipe 的 write 端 → node 的
 * stdout/stderr 读流永远拿不到 EOF → 事件循环不退出 → CI job 挂死到 timeout 被取消。
 */
const killProcessGroup = (child, signal = 'SIGTERM') => {
  // child.pid 为 null(spawn 失败)时 -pid 退化为 0,会向当前进程组发信号杀自己,故先守卫。
  if (child.pid == null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // 组已退出 / pid 非组长 → 退回单杀 child,避免误伤父进程所在组。
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

const spawnServer = (cmd, args, cwd, env, label) => {
  const server = spawn(cmd, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 独立 process group:stop() 用 process.kill(-pid) 杀整组(npm+vite),vite 退出后
    // stdio pipe 的 write 端关闭,node 读流拿 EOF 后事件循环才能退出。详见 killProcessGroup。
    detached: true,
  })
  const serverLog = []
  const remember = (chunk) => {
    const text = chunk.toString()
    serverLog.push(text)
    if (serverLog.length > 60) serverLog.shift()
  }
  server.stdout.on('data', remember)
  server.stderr.on('data', remember)
  return {
    server,
    serverLog,
    async stop() {
      if (server.exitCode != null) {
        server.stdout.destroy()
        server.stderr.destroy()
        return
      }
      killProcessGroup(server)
      await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(5000)])
      if (server.exitCode == null) killProcessGroup(server, 'SIGKILL')
      // 显式销毁 stdio 读流,释放可能被逃逸孙进程持有的 pipe handle,确保 node 事件循环可退出。
      server.stdout.destroy()
      server.stderr.destroy()
    },
    joinLog() {
      return serverLog.join('').trim()
    },
  }
}

const startDevServer = async (port, bffUrl) => {
  const env = { ...process.env, CI: '1' }
  if (bffUrl) env.MIVO_BFF_DEV_URL = bffUrl
  const handle = spawnServer(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    projectRoot,
    env,
    'dev',
  )
  try {
    await waitForServer(`http://127.0.0.1:${port}`, 60000)
  } catch (error) {
    await handle.stop()
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${handle.joinLog()}`)
  }
  return handle
}

const startBffServer = async (port, assetDir) => {
  const env = {
    ...process.env,
    MIVO_PORT: String(port),
    MIVO_ASSET_DIR: assetDir,
    MIVO_ENABLE_LOCAL_ASSETS: '1',
    // Eagle off (no local Eagle server in CI) + dev auth stub off → /api/auth/me
    // returns 401 (deterministic unauthenticated settings panel).
    MIVO_ENABLE_EAGLE_PROXY: '0',
    CI: '1',
  }
  const handle = spawnServer('npm', ['run', 'start:server'], projectRoot, env, 'bff')
  try {
    // Poll the local-assets endpoint: 200 means BFF bound + local-assets feature on.
    await waitForServer(`http://127.0.0.1:${port}/api/mivo/local-assets`, 60000)
  } catch (error) {
    await handle.stop()
    throw new Error(
      `BFF failed to start: ${error instanceof Error ? error.message : String(error)}\n${handle.joinLog()}`,
    )
  }
  return handle
}

/**
 * FU-8 / Phase 4b 旋转对照 fixture：旋转 image / rect / ellipse / note / dashed
 * line / 双头 arrow + 一对 connector 绑定节点。rotation 走 V2 transform（store
 * normalize 保留）；connector 的 markupPoints 由 replaceSnapshot 内的
 * normalizeCanvasGraph 归一化 —— DOM 与 Leafer 消费同一份归一化输出。
 * 坐标按默认 viewport (420,240,scale 1) 全部落在 1920×1080 视口内。
 */
const rotationFixtureNodes = () => {
  const node = (props) => ({ status: 'ready', title: props.id, ...props })
  const rotated = (props, rotation) => ({
    ...node(props),
    transform: { x: props.x, y: props.y, width: props.width, height: props.height, rotation },
  })
  return [
    rotated({ id: 'rot-image', type: 'image', x: 40, y: 40, width: 216, height: 384, assetUrl: '/demo-assets/courage-1.jpg' }, 30),
    rotated({ id: 'rot-rect', type: 'markup', markupKind: 'rect', x: 340, y: 60, width: 160, height: 120, markupFillColor: '#ffeecc', markupStrokeColor: '#112233', markupStrokeWidth: 4 }, 45),
    rotated({ id: 'rot-ellipse', type: 'markup', markupKind: 'ellipse', x: 560, y: 60, width: 160, height: 120 }, 20),
    rotated({ id: 'rot-note', type: 'markup', markupKind: 'note', x: 780, y: 80, width: 140, height: 140 }, -15),
    rotated({ id: 'rot-line', type: 'markup', markupKind: 'line', x: 340, y: 260, width: 220, height: 120, markupStrokeWidth: 4, markupStrokeStyle: 'dashed', markupPoints: [{ x: 10, y: 110 }, { x: 210, y: 10 }] }, 25),
    node({ id: 'flat-arrow', type: 'markup', markupKind: 'arrow', x: 620, y: 260, width: 240, height: 140, markupStrokeWidth: 3, markupOpacity: 0.82, markupStartArrow: true, markupPoints: [{ x: 10, y: 10 }, { x: 230, y: 130 }] }),
    node({ id: 'conn-a', type: 'markup', markupKind: 'rect', x: 40, y: 520, width: 120, height: 90 }),
    node({ id: 'conn-b', type: 'markup', markupKind: 'rect', x: 400, y: 620, width: 120, height: 90 }),
    node({
      id: 'conn-arrow',
      type: 'markup',
      markupKind: 'arrow',
      x: 160,
      y: 560,
      width: 240,
      height: 100,
      markupPoints: [{ x: 0, y: 0 }, { x: 240, y: 100 }],
      connectorStart: { nodeId: 'conn-a', anchor: 'right', offset: 0.5 },
      connectorEnd: { nodeId: 'conn-b', anchor: 'left', offset: 0.5 },
    }),
  ]
}

/**
 * Phase 4c brush/stamp 对照 fixture：marker 实心笔迹 / highlighter（0.42 半透明
 * 宽笔）/ dashed 笔迹（legacy polyline）/ 旋转笔迹 + stamp 贴纸（含旋转）+
 * FU-10 半透明描边 rect/ellipse（修复前 Leafer 会画成全不透明描边）。
 * 坐标按默认 viewport (420,240,scale 1) 全部落在 1920×1080 视口内。
 */
const brushStampFixtureNodes = () => {
  const node = (props) => ({ status: 'ready', title: props.id, ...props })
  const rotated = (props, rotation) => ({
    ...node(props),
    transform: { x: props.x, y: props.y, width: props.width, height: props.height, rotation },
  })
  const wave = [
    { x: 12, y: 96 },
    { x: 83, y: 40 },
    { x: 145, y: 108 },
    { x: 248, y: 48 },
  ]
  return [
    node({ id: 'brush-marker', type: 'markup', markupKind: 'brush', markupBrushKind: 'marker', x: 40, y: 40, width: 260, height: 160, markupPoints: wave, markupStrokeColor: '#d9542a', markupStrokeWidth: 6 }),
    node({ id: 'brush-highlighter', type: 'markup', markupKind: 'brush', markupBrushKind: 'highlighter', x: 360, y: 40, width: 260, height: 160, markupPoints: wave, markupStrokeColor: '#f7b500', markupStrokeWidth: 6, markupOpacity: 0.42 }),
    node({ id: 'brush-dashed', type: 'markup', markupKind: 'brush', markupBrushKind: 'marker', x: 680, y: 40, width: 260, height: 160, markupPoints: wave, markupStrokeColor: '#2563eb', markupStrokeWidth: 4, markupStrokeStyle: 'dashed' }),
    rotated({ id: 'brush-rotated', type: 'markup', markupKind: 'brush', markupBrushKind: 'marker', x: 40, y: 300, width: 260, height: 160, markupPoints: wave, markupStrokeColor: '#16a34a', markupStrokeWidth: 6 }, 30),
    node({ id: 'stamp-plus-one', type: 'markup', markupKind: 'stamp', markupStampKind: 'plus-one', x: 400, y: 320, width: 112, height: 112 }),
    rotated({ id: 'stamp-heart', type: 'markup', markupKind: 'stamp', markupStampKind: 'heart', x: 570, y: 330, width: 82, height: 82 }, -20),
    node({ id: 'fu10-rect', type: 'markup', markupKind: 'rect', x: 760, y: 300, width: 180, height: 120, markupStrokeColor: '#112233', markupStrokeWidth: 6, markupOpacity: 0.5 }),
    node({ id: 'fu10-ellipse', type: 'markup', markupKind: 'ellipse', x: 760, y: 470, width: 180, height: 120, markupStrokeColor: '#7c3aed', markupStrokeWidth: 6, markupOpacity: 0.35 }),
  ]
}

/**
 * Phase 5 静态文本 golden fixture:CJK 长段 / 中英混排 / 英文长词(anywhere
 * 断行)/ 显式换行(pre-wrap)/ 字号 12-24 / 字重 500 vs 700 / 三种对齐 /
 * 自定义颜色。node.width 决定换行盒宽,浏览器与 Leafer 的断行差异会直接
 * 表现为行数/字位错位 → 像素 diff 放大,是文本去向判决的核心证据。
 */
const textFixtureNodes = () => {
  const node = (props) => ({ status: 'ready', title: props.id, type: 'text', ...props })
  return [
    node({ id: 'txt-cjk', x: 40, y: 40, width: 280, height: 220, fontSize: 16, text: '无限画布要在内容越来越多的时候仍然保持流畅,渲染层就必须只处理视口内可见的那一小部分节点;缩小到全景时再用降级绘制兜底。这段话用于验证中日韩文字的逐字断行与行高。' }),
    node({ id: 'txt-mixed', x: 360, y: 40, width: 260, height: 200, fontSize: 16, text: 'Leafer 接入后 20k 节点 pan p95 只有 17.3ms(bar 是 33ms),比 DOM 的 100.1ms 快了 5.8x——mixed CJK/ASCII wrapping test 12345。' }),
    node({ id: 'txt-longword', x: 660, y: 40, width: 200, height: 180, fontSize: 16, text: 'Supercalifragilisticexpialidocious pneumonoultramicroscopicsilicovolcanoconiosis overflow-wrap-anywhere behavior check' }),
    node({ id: 'txt-newline', x: 900, y: 40, width: 240, height: 200, fontSize: 16, text: '第一行\n第二行较长一些用于观察\n\n空行之后的第四行' }),
    node({ id: 'txt-small', x: 40, y: 300, width: 220, height: 120, fontSize: 12, text: '小字号 12px:界面注释与图注常用尺寸,验证小字距下的断行稳定性。small 12px annotation text.' }),
    node({ id: 'txt-big-bold', x: 300, y: 300, width: 320, height: 160, fontSize: 24, fontWeight: 700, text: '大标题 24px 700 粗体 Heading Weight' }),
    node({ id: 'txt-center', x: 660, y: 300, width: 240, height: 120, fontSize: 16, textAlign: 'center', text: '居中对齐的多行文本\ncenter aligned lines' }),
    node({ id: 'txt-right', x: 940, y: 300, width: 240, height: 120, fontSize: 16, textAlign: 'right', text: '右对齐的多行文本\nright aligned lines' }),
    node({ id: 'txt-color', x: 40, y: 460, width: 280, height: 120, fontSize: 16, textColor: '#b3261e', text: '自定义颜色 #b3261e 的文本,验证 fill 透传。colored text sample.' }),
  ]
}


/**
 * FU-11 markup 文字层对照 fixture：note 正文 / rect、ellipse 标注 / line、arrow
 * 线上 label（缺口）+ 旋转、dashed、自定义字号/颜色。文字两种模式都走 DOM
 * （leafer 模式为 markup-text-overlay 纯文字壳），差异应集中在本体描边的
 * 抗锯齿；line/arrow 的 label 缺口数学与 DOM 同源（markupTextGeometry）。
 * mt-rect-empty 无文字——leafer 模式不应产生 DOM 壳（空壳回归探针）。
 * FU-12：mt-frame 标题壳对照；mt-frame-hidden 标题隐藏——两模式都不画标题
 * （dom 由 sectionTitleVisible 判断、leafer 由 filter 不放行壳，同为隐藏探针）。
 */
const markupTextFixtureNodes = () => {
  const node = (props) => ({ status: 'ready', title: props.id, type: 'markup', ...props })
  const rotated = (props, rotation) => ({
    ...node(props),
    transform: { x: props.x, y: props.y, width: props.width, height: props.height, rotation },
  })
  return [
    node({ id: 'mt-note', markupKind: 'note', x: 40, y: 40, width: 200, height: 160, text: '便签正文：文字层 DOM overlay 收口验证' }),
    node({ id: 'mt-rect', markupKind: 'rect', x: 300, y: 40, width: 220, height: 140, text: 'Rect 标注文字' }),
    node({ id: 'mt-ellipse', markupKind: 'ellipse', x: 580, y: 40, width: 220, height: 140, text: 'Ellipse label', textColor: '#b3261e', fontSize: 20 }),
    node({ id: 'mt-line', markupKind: 'line', x: 860, y: 60, width: 260, height: 120, markupStrokeWidth: 4, markupPoints: [{ x: 8, y: 112 }, { x: 252, y: 8 }], text: '线上 label' }),
    node({ id: 'mt-arrow', markupKind: 'arrow', x: 40, y: 300, width: 300, height: 140, markupStrokeWidth: 3, markupStartArrow: true, markupPoints: [{ x: 10, y: 10 }, { x: 290, y: 130 }], text: 'Flow label' }),
    rotated({ id: 'mt-rect-rot', markupKind: 'rect', x: 420, y: 300, width: 200, height: 130, text: '旋转标注', fontWeight: 700 }, 30),
    rotated({ id: 'mt-arrow-rot', markupKind: 'arrow', x: 700, y: 300, width: 260, height: 140, markupPoints: [{ x: 10, y: 130 }, { x: 250, y: 10 }], text: 'Rotated' }, -20),
    node({ id: 'mt-line-dashed', markupKind: 'line', x: 40, y: 520, width: 280, height: 100, markupStrokeStyle: 'dashed', markupStrokeWidth: 4, markupPoints: [{ x: 10, y: 90 }, { x: 270, y: 10 }], text: 'dashed 缺口' }),
    node({ id: 'mt-brush', markupKind: 'brush', markupBrushKind: 'marker', x: 620, y: 500, width: 260, height: 140, markupStrokeColor: '#d9542a', markupStrokeWidth: 6, markupPoints: [{ x: 12, y: 96 }, { x: 83, y: 40 }, { x: 145, y: 108 }, { x: 248, y: 48 }], text: 'brush 标注' }),
    node({ id: 'mt-rect-empty', markupKind: 'rect', x: 380, y: 520, width: 160, height: 100 }),
    { status: 'ready', id: 'mt-frame', type: 'frame', title: '分区标题 Section', x: 1160, y: 120, width: 320, height: 220 },
    { status: 'ready', id: 'mt-frame-hidden', type: 'frame', title: 'Hidden title', sectionTitleVisible: false, x: 1160, y: 420, width: 320, height: 200 },
  ]
}

const fixtureFor = (fixture) => {
  if (!fixture) return null
  if (fixture === 'rotation') {
    // dom 模式等注入的旋转图片位图落地（唯一的异步资源）。
    return { nodes: rotationFixtureNodes(), domReadySelector: '.dom-node img[src="/demo-assets/courage-1.jpg"]' }
  }
  if (fixture === 'text') {
    return { nodes: textFixtureNodes(), domReadySelector: '.dom-text-node' }
  }
  if (fixture === 'brush-stamp') {
    // dom 模式等 stamp 贴纸 <img> 挂载（笔迹是同步 SVG path）。
    return { nodes: brushStampFixtureNodes(), domReadySelector: '.dom-markup-stamp img' }
  }
  if (fixture === 'markup-text') {
    // 文字层两种模式都是 DOM——等 label 挂载即可。
    return { nodes: markupTextFixtureNodes(), domReadySelector: '.dom-markup-label' }
  }
  throw new Error(`Unknown --fixture value: ${fixture}`)
}

// ─── Shell (outer-UI) fixtures (T0.8) ──────────────────────────────────────
//
// Extend the SAME harness mechanism to UI surfaces the canvas-only fixtures don't
// reach: sidebar CRUD states, right-click context menu, confirm dialog, chat task
// cards, settings panel, changelog panel, asset library entry. Each shell fixture:
//   - seeds deterministic store state via page.evaluate(store) injection — the
//     same path the canvas fixtures use (canvasStore.setState / replaceSnapshot).
//     No src/ behavior change; the stores' public setState API is used as-is.
//   - drives transient UI (menus / dialogs / rename / panel opens) via Playwright
//     clicks against stable aria/text selectors — not pixel coordinates.
//   - declares readySelector (wait for the target UI to mount) + screenshotKind
//     ('element' captures a specific selector; 'viewport' captures the 1920×1080
//     viewport for in-context menus/dialogs/backdrops).
//   - freezes Date.now()/new Date() so time-sensitive UI (sidebar relative-time
//     labels, changelog 7-day window) is deterministic — the freeze only affects
//     no-arg new Date()/Date.now(); new Date(ms|iso) still resolves normally.
//   - runs baseline=dom / candidate=dom (self-diff = 0% proves baseline stable).
// All shell fixtures start the BFF (dual-process topology) so /api/auth/me +
// /api/mivo/local-assets resolve cleanly instead of proxying to a dead port.

// Deterministic sidebar seed: 2 projects + 5 canvases (3 grouped, 2 standalone).
// updatedAt values are chosen so formatSidebarTime labels are stable under the
// frozen clock (FROZEN_NOW_ISO): 当前画板→1 天, 独立草稿→6 天, 勇气 01→1 周,
// 勇气 02→1 周, 反派设定→2 周.
const SHELL_SIDEBAR_SEED = {
  sceneId: 'canvas-active',
  projects: [
    { id: 'proj-alpha', name: '新角色概念', createdAt: '2026-06-10T09:00:00+08:00' },
    { id: 'proj-beta', name: '场景原画', createdAt: '2026-06-18T14:30:00+08:00' },
  ],
  canvases: {
    'canvas-active': { title: '当前画板', createdAt: '2026-06-25T09:00:00+08:00', updatedAt: '2026-07-08T11:00:00+08:00', nodes: [], edges: [], tasks: [] },
    'canvas-standalone-1': { title: '独立草稿', createdAt: '2026-06-22T09:00:00+08:00', updatedAt: '2026-07-03T16:20:00+08:00', nodes: [], edges: [], tasks: [] },
    'canvas-alpha-1': { title: '勇气 01', projectId: 'proj-alpha', createdAt: '2026-06-15T09:00:00+08:00', updatedAt: '2026-07-01T10:00:00+08:00', nodes: [], edges: [], tasks: [] },
    'canvas-alpha-2': { title: '勇气 02', projectId: 'proj-alpha', createdAt: '2026-06-16T09:00:00+08:00', updatedAt: '2026-06-28T13:45:00+08:00', nodes: [], edges: [], tasks: [] },
    'canvas-beta-1': { title: '反派设定', projectId: 'proj-beta', createdAt: '2026-06-19T09:00:00+08:00', updatedAt: '2026-06-20T18:00:00+08:00', nodes: [], edges: [], tasks: [] },
  },
}

// Fixed-message chat payload exercising every ChatMessageList card state:
// user / done+result+enhance / generating(frozen spinner) / error(with medium-retry).
// createdAt is numeric; the chat UI does not render message timestamps, so the
// values only need to be stable (not time-accurate).
const SHELL_CHAT_PAYLOAD = (() => {
  const t0 = 1_752_000_000_000 // 2026-06-09T08:00:00Z — arbitrary stable epoch
  return {
    sceneId: 'canvas-active',
    nodes: [
      {
        id: 'img-result-1',
        type: 'image',
        title: '结果',
        status: 'ready',
        x: 80,
        y: 80,
        width: 512,
        height: 512,
        assetUrl: '/demo-assets/courage-1.jpg',
      },
    ],
    messages: [
      {
        id: 'msg-user-1',
        role: 'user',
        kind: 'text',
        text: '画一只戴帽子的橘猫,坐在窗台上,水彩风格',
        createdAt: t0,
        status: 'done',
        generationContext: {
          model: 'gemini-3-pro-image',
          requestedImgRatio: 'auto',
          requestedQuality: 'auto',
        },
      },
      {
        id: 'msg-asst-1',
        role: 'assistant',
        kind: 'text',
        text: '',
        createdAt: t0 + 60_000,
        status: 'done',
        resultNodeIds: ['img-result-1'],
        enhance: {
          richPrompt: '一只戴帽子的橘猫坐在窗台,水彩画风格,柔和光线,留白构图',
          imgRatio: '1:1',
          quality: 'medium',
        },
        generationContext: {
          model: 'gemini-3-pro-image',
          requestedImgRatio: 'auto',
          requestedQuality: 'auto',
          imgRatio: '1:1',
          quality: 'medium',
          finalPrompt: '橘猫窗台水彩',
        },
      },
      {
        id: 'msg-asst-2',
        role: 'assistant',
        kind: 'text',
        text: '',
        createdAt: t0 + 120_000,
        status: 'generating',
        generationContext: {
          model: 'gemini-3-pro-image',
          requestedImgRatio: 'auto',
          requestedQuality: 'auto',
          imgRatio: '1:1',
          quality: 'medium',
          finalPrompt: '赛博朋克版本的橘猫',
        },
      },
      {
        id: 'msg-asst-3',
        role: 'assistant',
        kind: 'text',
        text: '',
        createdAt: t0 + 180_000,
        status: 'error',
        error: '生成失败：上游超时(upstream-timeout)',
        errorKind: 'upstream-timeout',
        generationContext: {
          model: 'gemini-3-pro-image',
          requestedImgRatio: 'auto',
          requestedQuality: 'high',
          imgRatio: '16:9',
          quality: 'high',
          finalPrompt: '高清宽屏版本的橘猫',
        },
      },
    ],
  }
})()

const injectSidebarSeed = (page) =>
  page.evaluate(async (seed) => {
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    useCanvasStore.setState({
      sceneId: seed.sceneId,
      projects: seed.projects,
      canvases: seed.canvases,
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
  }, SHELL_SIDEBAR_SEED)

// Self-contained (runs in-page via waitForFunction/evaluate): true when every
// <img> under `sel` has finished decoding. Used to gate screenshots on async
// image loads (chat result image, asset library thumbnails).
const allImagesComplete = (sel) => {
  const imgs = Array.from(document.querySelectorAll(`${sel} img`))
  if (!imgs.length) return false
  return imgs.every((img) => img.complete && (img.naturalWidth || 1) > 0)
}

const SHELL_FIXTURES = {
  'shell-sidebar': {
    kind: 'shell',
    description: '侧栏 open 态:2 项目 + 5 画板(分组 + 独立),含 active 高亮 + 固定相对时间',
    async setup(page) {
      await injectSidebarSeed(page)
    },
    readySelector: '.project-sidebar .canvas-row',
    screenshotKind: 'element',
    screenshotSelector: '.project-sidebar',
  },
  'shell-sidebar-collapsed': {
    kind: 'shell',
    description: '侧栏收起态:浮动 chrome(nav.top-navigation,logo + 展开按钮)',
    async setup(page) {
      await injectSidebarSeed(page)
      // evaluate().click() dispatches the event ON the button (React onClick fires),
      // bypassing Playwright's pointer-based click whose hit-point lands on the
      // toggle's occluder (the toggle sits under the sidebar header mark overlay).
      await page.evaluate(() => {
        document.querySelector('.project-sidebar .sidebar-toggle')?.click()
      })
    },
    readySelector: 'nav.top-navigation',
    screenshotKind: 'element',
    screenshotSelector: 'nav.top-navigation',
  },
  'shell-sidebar-canvas-menu': {
    kind: 'shell',
    description: '侧栏画板行右键菜单(非画布 NodeActionMenu):重命名 / 移动到项目 ▸ / 复制画板 / ─ / 删除',
    async setup(page) {
      await injectSidebarSeed(page)
      await page.locator('.canvas-row').first().click({ button: 'right', force: true })
    },
    readySelector: '.sidebar-context-menu',
    screenshotKind: 'viewport',
    screenshotSelector: null,
  },
  'shell-sidebar-canvas-submenu': {
    kind: 'shell',
    description: '侧栏画板行菜单「移动到项目」子菜单展开(2 项目 + 移到 Canvas)',
    async setup(page) {
      await injectSidebarSeed(page)
      await page.locator('.canvas-row').first().click({ button: 'right', force: true })
      await page.locator('.sidebar-context-menu').first().waitFor({ state: 'visible' })
      await page
        .locator('.sidebar-context-menu-item')
        .filter({ hasText: '移动到项目' })
        .click({ force: true })
    },
    readySelector: '.sidebar-context-menu-submenu',
    screenshotKind: 'viewport',
    screenshotSelector: null,
  },
  'shell-node-context-menu': {
    kind: 'shell',
    description: '画布 NodeActionMenu(右键 image 节点):View details / Copy image / Duplicate image / Fit selection … — canvasActionModel.contextMenuGroupsFor(单 image),区别于侧栏画板行菜单',
    async setup(page) {
      // Seed a single ready image node, then right-click it. The right-click lands
      // on .dom-node (pointer-events:auto) → handleCanvasContextMenu →
      // nodeIdFromDomTarget resolves data-node-id → openNodeContextMenu →
      // NodeActionMenu renders contextMenuGroupsFor(single image). This is the
      // T2.3 command-migration UI face; the postReady guard proves it is the real
      // canvas node menu (English "View details"), not the sidebar canvas-row menu.
      const node = {
        id: 'img-context-1',
        type: 'image',
        title: '勇气 01',
        status: 'ready',
        x: 300,
        y: 200,
        width: 320,
        height: 320,
        assetUrl: '/demo-assets/courage-1.jpg',
      }
      await page.evaluate(async (n) => {
        const { useCanvasStore } = await import('/src/store/canvasStore.ts')
        useCanvasStore.setState({
          sceneId: 'canvas-active',
          projects: [],
          canvases: {
            'canvas-active': {
              title: '当前画板',
              createdAt: '2026-06-25T09:00:00+08:00',
              updatedAt: '2026-07-08T11:00:00+08:00',
              nodes: [n],
              edges: [],
              tasks: [],
            },
          },
          nodes: [n],
          edges: [],
          tasks: [],
          selectedNodeId: undefined,
          selectedNodeIds: [],
        })
      }, node)
      await page.locator('.dom-node[data-node-type="image"]').first().click({ button: 'right' })
    },
    readySelector: '.node-action-menu',
    screenshotKind: 'viewport',
    screenshotSelector: null,
    postReady: async (page) => {
      // Hard guard (F2): prove this is the real canvas NodeActionMenu
      // (contextMenuGroupsFor single image), not the sidebar canvas-row menu
      // (which is Chinese 重命名/移动到项目/复制画板/删除). Single image →
      // "View details" + "Duplicate image" items must be present.
      const items = await page.locator('.node-action-item').allTextContents()
      const joined = items.join('|')
      if (!joined.includes('View details') || !joined.includes('Duplicate')) {
        throw new Error(
          `shell-node-context-menu: expected canvas NodeActionMenu (View details / Duplicate …), got items: ${joined}`,
        )
      }
      // Wait for the seeded image to decode so the baseline is pixel-stable.
      await page
        .waitForFunction(allImagesComplete, '.dom-node[data-node-type="image"]', { timeout: 10000 })
        .catch(() => {})
    },
  },
  'shell-confirm-dialog': {
    kind: 'shell',
    description: '删除画板确认弹窗:标题 / 描述 / 取消 / 删除(danger)',
    async setup(page) {
      await injectSidebarSeed(page)
      await page.locator('.canvas-row').first().click({ button: 'right', force: true })
      await page.locator('.sidebar-context-menu').first().waitFor({ state: 'visible' })
      await page
        .locator('.sidebar-context-menu-item')
        .filter({ hasText: '删除' })
        .click({ force: true })
    },
    readySelector: '.sidebar-confirm-dialog',
    screenshotKind: 'viewport',
    screenshotSelector: null,
  },
  'shell-canvas-rename': {
    kind: 'shell',
    description: '画板双击内联改名:EditableName 输入框激活',
    async setup(page) {
      await injectSidebarSeed(page)
      await page.locator('.canvas-row').first().click({ clickCount: 2, force: true })
    },
    readySelector: '.sidebar-editable-name',
    screenshotKind: 'element',
    screenshotSelector: '.project-sidebar',
  },
  'shell-chat-empty': {
    kind: 'shell',
    description: '对话面板空态:输入提示语占位',
    async setup(page) {
      await injectSidebarSeed(page)
    },
    readySelector: '.chat-message-list-empty',
    screenshotKind: 'element',
    screenshotSelector: '.ai-panel.chat-panel-expanded',
  },
  'shell-chat-task-cards': {
    kind: 'shell',
    description: '对话任务卡各态:user / done+结果图+参数卡 / generating(冻结 spinner) / error(含中质量重试)',
    async setup(page) {
      await page.evaluate(async (payload) => {
        const { useCanvasStore } = await import('/src/store/canvasStore.ts')
        const { useChatStore } = await import('/src/store/chatStore.ts')
        useCanvasStore.setState({
          sceneId: payload.sceneId,
          projects: [],
          canvases: { [payload.sceneId]: { title: '当前画板', createdAt: '2026-06-25T09:00:00+08:00', updatedAt: '2026-07-08T11:00:00+08:00', nodes: payload.nodes, edges: [], tasks: [] } },
          nodes: payload.nodes,
          edges: [],
          tasks: [],
          selectedNodeId: undefined,
          selectedNodeIds: [],
        })
        useChatStore.setState({ messagesByScene: { [payload.sceneId]: payload.messages }, isBusy: false })
      }, SHELL_CHAT_PAYLOAD)
    },
    readySelector: '.chat-result-image',
    screenshotKind: 'element',
    screenshotSelector: '.ai-panel.chat-panel-expanded',
    postReady: async (page, selector) => {
      // 结果图从 Vite 静态资源加载,等 <img> 解码完成再截
      await page.waitForFunction(allImagesComplete, selector, { timeout: 10000 }).catch(() => {})
    },
  },
  'shell-settings-panel': {
    kind: 'shell',
    description: '设置面板未登录态:账号区显示「登录」+ API Keys 锁定行',
    // This fixture deliberately opens the Settings panel itself: the global
    // __MIVO_E2E_DISABLE_AUTO_PROMPT__ flag suppresses the auto-prompt effect,
    // so setup calls openSettings('account') directly to render .settings-panel.
    // Opts out of the hard "settings-panel absent" guard in captureScreenshot.
    expectSettingsPanel: true,
    async setup(page) {
      await page.evaluate(async () => {
        const { useAuthStore } = await import('/src/store/authSlice.ts')
        useAuthStore.setState({ user: null, status: 'unauthenticated' })
        const { useSettingsStore } = await import('/src/store/settingsSlice.ts')
        useSettingsStore.getState().markAutoPrompted()
        useSettingsStore.getState().openSettings('account')
      })
    },
    readySelector: '.settings-panel',
    screenshotKind: 'viewport',
    screenshotSelector: null,
  },
  'shell-changelog-panel': {
    kind: 'shell',
    description: '更新日志面板:7 天窗口轮播 index 0(最新一天),含作者分组 + 分页圆点',
    async setup(page) {
      await injectSidebarSeed(page)
      // changelog 数据在 ProjectSidebar mount 时即从 /changelog.json 加载(Vite
      // 静态直出,快);readySelector='.changelog-day' 门控截图,空态不会入镜。
      // evaluate().click() dispatches on the button directly — Playwright's pointer
      // click hits the badge-dot/overlay that occludes the changelog-row center.
      await page.evaluate(() => {
        document.querySelector('button.changelog-row')?.click()
      })
    },
    readySelector: '.changelog-day',
    screenshotKind: 'viewport',
    screenshotSelector: null,
  },
  'shell-asset-library': {
    kind: 'shell',
    description: '素材库入口(Assets 抽屉):Local 源 3 张确定性 demo 图 + Eagle 未连接占位',
    requiresBff: true,
    async setup(page) {
      await injectSidebarSeed(page)
      // evaluate().click() on the Assets nav button directly — same occlusion
      // reason as the sidebar-toggle / changelog-row (pointer hit-point lands on
      // an overlay, not the button). Find by text since multiple .nav-row buttons
      // share the primary-actions section.
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('.sidebar-section.primary-actions button.nav-row'))
        const target = buttons.find((b) => (b.textContent || '').includes('Assets'))
        target?.click()
      })
    },
    readySelector: '.asset-grid .asset-tile img',
    screenshotKind: 'element',
    screenshotSelector: '.library-workspace',
    postReady: async (page, selector) => {
      await page.waitForFunction(allImagesComplete, selector, { timeout: 10000 }).catch(() => {})
    },
  },
}

const fixtureDescriptor = (fixture) => {
  if (!fixture) return null
  if (Object.hasOwn(SHELL_FIXTURES, fixture)) {
    return { kind: 'shell', name: fixture, ...SHELL_FIXTURES[fixture] }
  }
  const canvas = fixtureFor(fixture)
  return { kind: 'canvas', nodes: canvas?.nodes ?? null, domReadySelector: canvas?.domReadySelector ?? null }
}

const buildPageInitScript = (freeze) => {
  const lines = ['globalThis.__MIVO_BENCH_PERSIST_SKIP__ = true;']
  if (!freeze) return lines.join('\n')
  // Shell fixtures opt out of the AutoPromptSettings effect (the existing
  // window.__MIVO_E2E_DISABLE_AUTO_PROMPT__ opt-out in AutoPromptSettings.tsx):
  // the BFF dev auth stub returns 401, which would otherwise auto-open the
  // Settings overlay (account section) on every shell load and contaminate
  // non-settings baselines — the shell-changelog-panel regression captured the
  // overlay sitting over the changelog. shell-settings-panel opens the panel
  // itself in its setup, so it isn't affected. Canvas fixtures keep the original
  // init script (no settings UI in canvas view) — only shell (freeze=true) sets this.
  lines.push('globalThis.__MIVO_E2E_DISABLE_AUTO_PROMPT__ = true;')
  lines.push(`
    const FROZEN = Date.parse(${JSON.stringify(FROZEN_NOW_ISO)});
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(FROZEN); else super(...a); }
    }
    FrozenDate.now = () => FROZEN;
    FrozenDate.parse = RealDate.parse;
    FrozenDate.UTC = RealDate.UTC;
    window.Date = FrozenDate;
  `)
  return lines.join('\n')
}

const captureScreenshot = async ({ browser, port, renderer, dpr, label, descriptor, freeze, textPaint }) => {
  const pageQuery = `renderer=${encodeURIComponent(renderer)}${textPaint && renderer === 'leafer' ? `&textPaint=${encodeURIComponent(textPaint)}` : ''}`
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: dpr,
    colorScheme: 'light',
  })
  const isShell = descriptor?.kind === 'shell'
  const fixtureNodes = descriptor?.kind === 'canvas' ? descriptor.nodes ?? null : null
  const page = await context.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Shell fixtures freeze the clock; canvas fixtures with injected nodes opt out
  // of IDB writes (bench parity). No-fixture self-checks skip the init script
  // entirely (preserves the original behavior for `npm run visual:diff`).
  if (isShell || fixtureNodes) {
    await page.addInitScript(buildPageInitScript(isShell))
  }
  await page.goto(`http://127.0.0.1:${port}/?${pageQuery}`, { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS })
  await page.evaluate(() => window.localStorage.clear())
  await page.goto(`http://127.0.0.1:${port}/?${pageQuery}`, { waitUntil: 'networkidle' })
  // Re-inject the disable-animations <style> on the post-2nd-goto page — the
  // between-gotos addStyleTag above is lost on navigation. Without it the sidebar
  // open/peek CSS transitions stay active during setup clicks, and Playwright's
  // auto-wait flags the target element as perpetually "not stable" (click 30s
  // timeout). The document is fully parsed here so document.head exists.
  await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS })
  await page.waitForSelector('.canvas-shell')
  if (isShell) {
    await descriptor.setup(page)
    await page.waitForSelector(descriptor.readySelector, { state: 'visible', timeout: 15000 })
    if (descriptor.postReady) await descriptor.postReady(page, descriptor.screenshotSelector)
    await page.waitForTimeout(300)
    // Hard guard (F1): non-settings shell fixtures must NOT show the Settings
    // overlay. __MIVO_E2E_DISABLE_AUTO_PROMPT__ suppresses AutoPromptSettings, so
    // a .settings-panel here means the overlay leaked into the baseline — the
    // regression that contaminated shell-changelog-panel (settings overlay sat
    // over the changelog). shell-settings-panel opts out via expectSettingsPanel.
    if (!descriptor.expectSettingsPanel) {
      const leaked = await page.locator('.settings-panel').count()
      if (leaked > 0) {
        throw new Error(
          `shell fixture "${descriptor.name}" leaked .settings-panel (count=${leaked}); auto-prompt opt-out failed to suppress the Settings overlay`,
        )
      }
    }
  } else if (fixtureNodes) {
    // 注入固定文档（replaceSnapshot 内部跑 normalizeCanvasGraph → connector
    // markupPoints 归一化，DOM/Leafer 消费同一输出）。
    await page.evaluate(async (nodes) => {
      const { useCanvasStore } = await import('/src/store/canvasStore.ts')
      const snapshot = useCanvasStore.getState().getSnapshot()
      useCanvasStore.getState().replaceSnapshot({
        ...snapshot,
        nodes,
        edges: [],
        tasks: [],
        selectedNodeId: undefined,
        selectedNodeIds: [],
      })
    }, fixtureNodes)
    if (renderer === 'leafer') {
      await page.waitForFunction(
        (mode) => {
          const shell = document.querySelector('.canvas-shell')
          const expected = Number(shell?.getAttribute('data-leafer-expected-children') || 0)
          const children = Number(shell?.getAttribute('data-leafer-children') || 0)
          return shell?.getAttribute('data-renderer-mode') === mode &&
            expected > 0 &&
            children === expected &&
            shell?.getAttribute('data-leafer-pixel-nonempty') === 'true'
        },
        'leafer',
        { timeout: 15000 },
      )
    } else {
      await page.waitForSelector(descriptor.domReadySelector)
    }
    await page.waitForTimeout(300)
  } else if (renderer === 'leafer') {
    // leafer 模式 image/frame 由 Leafer 画，DOM 无 <img>；等 data-renderer-mode + paint 证据稳定
    await page.waitForFunction(
      (mode) => {
        const shell = document.querySelector('.canvas-shell')
        const expected = Number(shell?.getAttribute('data-leafer-expected-children') || 0)
        const children = Number(shell?.getAttribute('data-leafer-children') || 0)
        return shell?.getAttribute('data-renderer-mode') === mode &&
          expected > 0 &&
          children === expected &&
          shell?.getAttribute('data-leafer-pixel-nonempty') === 'true'
      },
      'leafer',
      { timeout: 15000 },
    )
    await page.waitForTimeout(300)
  } else {
    await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
    await page.waitForTimeout(300)
  }

  const renderState = await page.evaluate(() => {
    const shell = document.querySelector('.canvas-shell')
    return {
      rendererMode: shell?.getAttribute('data-renderer-mode') || 'dom',
      leaferExpectedChildren: Number(shell?.getAttribute('data-leafer-expected-children') || 0),
      leaferChildren: Number(shell?.getAttribute('data-leafer-children') || 0),
      leaferPixelNonEmpty: shell?.getAttribute('data-leafer-pixel-nonempty') === 'true',
    }
  })
  let pngBuffer
  if (isShell && descriptor.screenshotKind === 'viewport') {
    pngBuffer = await page.screenshot({ type: 'png' })
  } else if (isShell) {
    pngBuffer = await page.locator(descriptor.screenshotSelector).first().screenshot({ type: 'png' })
  } else {
    pngBuffer = await page.locator('.canvas-shell').screenshot({ type: 'png' })
  }
  const png = PNG.sync.read(pngBuffer)
  await context.close()
  return { label, renderer, renderState, png, pngBuffer }
}

const diffImages = (baseline, candidate) => {
  const { width, height } = baseline.png
  if (candidate.png.width !== width || candidate.png.height !== height) {
    throw new Error(`Screenshot size mismatch: baseline ${width}x${height} vs candidate ${candidate.png.width}x${candidate.png.height}`)
  }
  const diff = new PNG({ width, height })
  const mismatchedPixels = pixelmatch(baseline.png.data, candidate.png.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: false,
  })
  const totalPixels = width * height
  const diffPercent = Number(((mismatchedPixels / totalPixels) * 100).toFixed(4))
  const passed = diffPercent <= DIFF_THRESHOLD_PERCENT
  return { mismatchedPixels, totalPixels, diffPercent, passed, diffPng: diff }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  // Per-fixture output dir when a fixture is selected and --output wasn't passed
  // explicitly — matches the observed test-artifacts/visual-diff-<fixture> layout
  // and keeps shell + canvas fixtures from clobbering each other's baselines.
  // No-fixture runs (npm run visual:diff) keep the default test-artifacts/visual-diff.
  if (options.fixture && !options.outputExplicit) {
    options.outputDir = `test-artifacts/visual-diff-${options.fixture}`
  }
  await mkdir(`${projectRoot}/${options.outputDir}`, { recursive: true })

  const descriptor = fixtureDescriptor(options.fixture)
  const isShell = descriptor?.kind === 'shell'
  const bffUrl = isShell ? `http://127.0.0.1:${BFF_PORT}` : null
  const bffServer = isShell ? await startBffServer(BFF_PORT, BFF_ASSET_DIR) : null
  let devServer
  try {
    devServer = await startDevServer(options.port, bffUrl)
  } catch (error) {
    if (bffServer) await bffServer.stop()
    throw error
  }

  // P1-1: browser 声明为 let + launch 挪进主 try——launch 抛错(无浏览器二进制/sandbox 失败)
  // 时 finally 才会跑并 stop devServer/bffServer;原 launch 在 try 外,失败时两 server 泄漏端口。
  let browser
  try {
    browser = await chromium.launch({ headless: options.headless, args: DEFAULT_BROWSER_FLAGS })
    const baseline = await captureScreenshot({
      browser,
      port: options.port,
      renderer: options.baseline,
      dpr: options.dpr,
      label: 'baseline',
      descriptor,
      freeze: isShell,
    })
    const candidate = await captureScreenshot({
      browser,
      port: options.port,
      renderer: options.candidate,
      dpr: options.dpr,
      label: 'candidate',
      descriptor,
      freeze: isShell,
      textPaint: options.textPaint,
    })

    const diff = diffImages(baseline, candidate)
    const fixtureSuffix = options.fixture ? `-${options.fixture}` : ''
    const baselinePath = `${options.outputDir}/baseline-${options.baseline}${fixtureSuffix}.png`
    const candidatePath = `${options.outputDir}/candidate-${options.candidate}${fixtureSuffix}.png`
    const diffPath = `${options.outputDir}/diff-${options.baseline}-vs-${options.candidate}${fixtureSuffix}.png`
    const reportPath = `${options.outputDir}/diff-report${fixtureSuffix}.json`

    await writeFile(`${projectRoot}/${baselinePath}`, PNG.sync.write(baseline.png))
    await writeFile(`${projectRoot}/${candidatePath}`, PNG.sync.write(candidate.png))
    await writeFile(`${projectRoot}/${diffPath}`, PNG.sync.write(diff.diffPng))
    await writeFile(
      `${projectRoot}/${reportPath}`,
      `${JSON.stringify({
        baseline: { renderer: options.baseline, ...baseline.renderState, path: baselinePath },
        candidate: { renderer: options.candidate, ...candidate.renderState, path: candidatePath },
        diff: {
          mismatchedPixels: diff.mismatchedPixels,
          totalPixels: diff.totalPixels,
          diffPercent: diff.diffPercent,
          thresholdPercent: DIFF_THRESHOLD_PERCENT,
          passed: diff.passed,
          artifactPath: diffPath,
        },
        dpr: options.dpr,
        fixture: options.fixture,
      }, null, 2)}\n`,
    )

    const status = diff.diffPercent <= DIFF_THRESHOLD_PERCENT ? 'PASS' : 'FAIL'
    console.log(`[visual-diff] ${status} baseline=${options.baseline} candidate=${options.candidate} dpr=${options.dpr}${options.fixture ? ` fixture=${options.fixture}` : ''} diff=${diff.diffPercent}% (threshold ${DIFF_THRESHOLD_PERCENT}%)`)
    console.log(`[visual-diff] baseline rendererMode=${baseline.renderState.rendererMode} candidate rendererMode=${candidate.renderState.rendererMode}`)
    console.log(`[visual-diff] artifacts: ${reportPath}, ${diffPath}`)

    if (!diff.passed) {
      process.exitCode = 1
    }
  } finally {
    // P1-1: 每个资源独立 try/catch + 判空——原串行裸 await 前一个抛错会跳过后面的,
    // 导致 devServer/bffServer 不被 stop → 端口 4179/8089 泄漏挂死 CI。保证三个都被尝试停掉。
    try {
      if (browser) await browser.close()
    } catch (error) {
      console.error('[visual-diff] browser.close failed:', error instanceof Error ? error.message : error)
    }
    try {
      await devServer.stop()
    } catch (error) {
      console.error('[visual-diff] devServer.stop failed:', error instanceof Error ? error.message : error)
    }
    try {
      if (bffServer) await bffServer.stop()
    } catch (error) {
      console.error('[visual-diff] bffServer.stop failed:', error instanceof Error ? error.message : error)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
