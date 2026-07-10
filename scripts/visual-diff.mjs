import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { chromium } from 'playwright'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { projectRoot } from './bench/fixture-lib.mjs'

/**
 * 视觉 diff harness（Leafer 接入 PR-1 / Phase 0a 工装）。
 *
 * 固定场景、固定 DPR、禁动画（prefers-reduced-motion + 禁 transition），
 * 生成 baseline + candidate 截图 + diff 百分比 + diff artifact。
 *
 * 当前只支持 DOM 渲染（leafer renderer 未实现，等同 dom）。
 * 默认 DOM-vs-DOM 自检：同场景两次截图，diff 应 = 0%。
 *
 * 用法：
 *   node scripts/visual-diff.mjs                         # DOM vs DOM 自检
 *   node scripts/visual-diff.mjs --candidate=leafer      # DOM baseline vs leafer candidate（占位）
 *   node scripts/visual-diff.mjs --dpr=2                 # 固定 DPR=2
 *   node scripts/visual-diff.mjs --port=4180             # 自定义 dev 端口
 *   node scripts/visual-diff.mjs --candidate=leafer --fixture=rotation
 *       # FU-8 旋转对照：注入旋转 image/rect/ellipse/note/line/arrow + connector
 *       # 固定文档（bench 同款 replaceSnapshot 注入），DOM vs Leafer 像素对照
 *   node scripts/visual-diff.mjs --candidate=leafer --fixture=brush-stamp
 *   node scripts/visual-diff.mjs --candidate=leafer --fixture=markup-text
 *       # Phase 4c 对照：marker/highlighter/dashed/旋转 brush + stamp（含旋转）
 *       # + FU-10 半透明描边 rect/ellipse，DOM vs Leafer 像素对照
 */

const DEFAULT_PORT = 4179
const DEFAULT_DPR = 1
const DIFF_THRESHOLD_PERCENT = 5.0

const DEFAULT_BROWSER_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

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
    } else if (entry.startsWith('--output=')) options.outputDir = entry.slice('--output='.length) || options.outputDir
    else if (entry === '--headed') options.headless = false
  }
  return options
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForServer = async (url, timeoutMs = 60000) => {
  const startedAt = Date.now()
  let lastError = new Error('Timed out waiting for dev server')
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
          response.resume()
          response.statusCode && response.statusCode < 500 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`))
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

const startDevServer = async (port) => {
  const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: projectRoot,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // 独立 process group:stop() 用 process.kill(-pid) 杀整组(npm+vite),vite 退出后
    // stdio pipe 的 write 端关闭,node 读流拿 EOF 后事件循环才能退出。详见 killProcessGroup。
    detached: true,
  })
  const serverLog = []
  const remember = (chunk) => {
    const text = chunk.toString()
    serverLog.push(text)
    if (serverLog.length > 40) serverLog.shift()
  }
  server.stdout.on('data', remember)
  server.stderr.on('data', remember)

  try {
    await waitForServer(`http://127.0.0.1:${port}`, 60000)
  } catch (error) {
    killProcessGroup(server)
    server.stdout.destroy()
    server.stderr.destroy()
    const detail = serverLog.join('').trim()
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`)
  }

  return {
    server,
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
  }
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

const captureScreenshot = async ({ browser, port, renderer, dpr, label, fixture, textPaint }) => {
  const pageQuery = `renderer=${encodeURIComponent(renderer)}${textPaint && renderer === 'leafer' ? `&textPaint=${encodeURIComponent(textPaint)}` : ''}`
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: dpr,
    colorScheme: 'light',
  })
  const fixtureDescriptor = fixtureFor(fixture)
  const fixtureNodes = fixtureDescriptor?.nodes ?? null
  const page = await context.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  if (fixtureNodes) {
    // bench 同款：注入文档不写 IDB（persistIdbStorage 读此 flag），两次采集互不污染。
    await page.addInitScript(() => {
      globalThis.__MIVO_BENCH_PERSIST_SKIP__ = true
    })
  }
  await page.goto(`http://127.0.0.1:${port}/?${pageQuery}`, { waitUntil: 'networkidle' })
  await page.addStyleTag({
    content: [
      '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}',
      'html,body{caret-color:transparent!important;}',
    ].join(''),
  })
  await page.evaluate(() => window.localStorage.clear())
  await page.goto(`http://127.0.0.1:${port}/?${pageQuery}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.canvas-shell')
  if (fixtureNodes) {
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
      await page.waitForSelector(fixtureDescriptor.domReadySelector)
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

  const shell = page.locator('.canvas-shell')
  const renderState = await page.evaluate(() => {
    const shell = document.querySelector('.canvas-shell')
    return {
      rendererMode: shell?.getAttribute('data-renderer-mode') || 'dom',
      leaferExpectedChildren: Number(shell?.getAttribute('data-leafer-expected-children') || 0),
      leaferChildren: Number(shell?.getAttribute('data-leafer-children') || 0),
      leaferPixelNonEmpty: shell?.getAttribute('data-leafer-pixel-nonempty') === 'true',
    }
  })
  const pngBuffer = await shell.screenshot({ type: 'png' })
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
  await mkdir(`${projectRoot}/${options.outputDir}`, { recursive: true })

  const devServer = await startDevServer(options.port)
  const browser = await chromium.launch({ headless: options.headless, args: DEFAULT_BROWSER_FLAGS })

  try {
    const baseline = await captureScreenshot({
      browser,
      port: options.port,
      renderer: options.baseline,
      dpr: options.dpr,
      label: 'baseline',
      fixture: options.fixture,
    })
    const candidate = await captureScreenshot({
      browser,
      port: options.port,
      renderer: options.candidate,
      dpr: options.dpr,
      label: 'candidate',
      fixture: options.fixture,
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
    await browser.close()
    await devServer.stop()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
