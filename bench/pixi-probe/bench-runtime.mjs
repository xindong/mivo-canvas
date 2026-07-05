// Standalone PixiJS bare-render probe runtime for MivoCanvas engine-selection comparison.
//
// This page is NOT part of the app. It boots a Pixi v8 Application, renders the SAME
// bench fixtures used by scripts/bench/collect.mjs (bench/fixtures/bench-dom-mixed-*.json),
// and exposes a capture runtime (globalThis.__MIVO_PIXI_BENCH__) that mirrors the
// __MIVO_BENCH__ surface from collect.mjs: loadFixture / waitForRender / startCapture /
// stopCapture, plus a getRenderState() evidence reader.
//
// Pan/zoom are handled in-page via Pixi federated events so the existing Playwright
// mouse gesture (identical coordinates/steps/wheel deltas to collect.mjs) drives the
// viewport transform and the rAF frame deltas reflect the per-frame 20k-node render cost.
//
// Honesty note: this measures the Pixi ENGINE CEILING — there is no React/zustand store,
// no per-node DOM, no app-layer overhead. It is NOT a measurement of integrated-app
// performance. See REPORT.md for the asymmetry write-up.
import {
  Application,
  Container,
  Culler,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
  extensions,
  CullerPlugin,
} from 'pixi.js'

const shell = document.querySelector('.canvas-shell')
const hud = document.getElementById('hud')
const setStatus = (status, extra) => {
  shell.setAttribute('data-pixi-status', status)
  hud.textContent = `pixi probe — ${status}${extra ? ` · ${extra}` : ''}`
}
const setError = (msg) => {
  shell.setAttribute('data-pixi-status', 'error')
  hud.innerHTML = `pixi probe — error: <span class="err">${msg}</span>`
  console.error('[pixi-probe]', msg)
}

const params = new URLSearchParams(location.search)
const DPR = Number(params.get('dpr') || '1')
// text strategy: "on" = render text nodes as Pixi Text (realistic, unique textures);
// "skip" = do not render text nodes (engine-ceiling lower bound). Recorded in report.
const TEXT_STRATEGY = params.get('text') || 'on'
// culling: "off" (default) = draw all children every frame (matches 0b culling=off, the
// hardest case); "on" = Pixi CullerPlugin auto-culls off-screen children against the
// screen rect each prerender (matches 0b culling=on, the realistic app path).
const CULLING = params.get('culling') === 'on' ? 'on' : 'off'
const VIEWPORT_W = 1920
const VIEWPORT_H = 1080
// background clear color (#1a1a1a = 26,26,26) — used by the pixel-non-empty guard to
// distinguish rendered content from the cleared background.
const BG_R = 26
const BG_G = 26
const BG_B = 26

// --- placeholder texture pool (image nodes) ---
// Real assetUrl files (/demo-assets/*.jpg) are not present in the probe. To simulate the
// mixed render load we generate a small pool of canvas textures (gradients + noise) and
// cycle them across image Sprites. This gives Pixi's batcher shared textures → batched
// draw calls, which is the realistic best case for an image-heavy canvas. The exact
// texture content does not affect pan render cost (transform-only); texture count does.
const TEXTURE_POOL_SIZE = 8
const texturePool = []
const buildTexturePool = () => {
  texturePool.length = 0
  for (let i = 0; i < TEXTURE_POOL_SIZE; i += 1) {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 256
    const ctx = c.getContext('2d')
    const hue = (i * 360) / TEXTURE_POOL_SIZE
    const g = ctx.createLinearGradient(0, 0, 256, 256)
    g.addColorStop(0, `hsl(${hue}, 70%, 55%)`)
    g.addColorStop(1, `hsl(${(hue + 60) % 360}, 60%, 30%)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 256, 256)
    // a little visual detail so the texture isn't a flat color (closer to real artwork)
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    for (let j = 0; j < 14; j += 1) {
      ctx.beginPath()
      ctx.arc(Math.random() * 256, Math.random() * 256, 8 + Math.random() * 24, 0, Math.PI * 2)
      ctx.fill()
    }
    texturePool.push(Texture.from(c))
  }
}

const hexToInt = (hex) => {
  if (!hex) return 0xffffff
  const h = hex.replace('#', '')
  return parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
}

// --- Pixi Application ---
let app = null
let world = null // single container holding all node sprites/graphics/text
let createdNodes = [] // for teardown on reload

const boot = async () => {
  try {
    app = new Application()
    if (CULLING === 'on') {
      // Register the culler plugin so it auto-culls app.stage against renderer.screen
      // before every render. Children opt in via cullable=true + a cullArea rectangle
      // (set in renderFixture) so the culler skips expensive per-frame getBounds() calls.
      extensions.add(CullerPlugin)
    }
    await app.init({
      width: VIEWPORT_W,
      height: VIEWPORT_H,
      background: '#1a1a1a',
      antialias: false,
      // Force WebGL (not WebGPU) so the renderer exposes a `.gl` handle for the pixel
      // evidence check AND so the comparison stays apples-to-apples with the Leafer
      // (canvas/WebGL) 0b baseline. WebGPU would be a different, faster code path.
      preference: 'webgl',
      resolution: DPR,
      autoDensity: true,
      powerPreference: 'high-performance',
      ...(CULLING === 'on' ? { culler: { updateTransform: true } } : {}),
      // NOTE: keep preserveDrawingBuffer at its default (false) so the pan/zoom frame
      // measurements aren't biased by the GPU keeping the buffer every frame. The pixel
      // evidence guard renders + readPixels synchronously in the same tick (see
      // samplePixelsNonEmpty), which reads a valid buffer without preservation.
    })
    shell.appendChild(app.canvas)
    world = new Container()
    world.sortableChildren = false
    if (CULLING === 'on') {
      world.cullable = true
      world.cullableChildren = true
    }
    app.stage.addChild(world)

    buildTexturePool()

    // Stage-level interaction: pan (pointer drag) + zoom (wheel). Children are
    // non-interactive so the stage always receives the gesture — correct for a
    // pan/zoom ceiling test where we are NOT measuring per-node hit-testing.
    app.stage.eventMode = 'static'
    app.stage.hitArea = new Rectangle(0, 0, VIEWPORT_W, VIEWPORT_H)

    let dragging = false
    let dragStart = null
    let worldStart = null
    app.stage.on('pointerdown', (e) => {
      if (e.button !== 0) return
      dragging = true
      dragStart = { x: e.global.x, y: e.global.y }
      worldStart = { x: world.position.x, y: world.position.y }
    })
    app.stage.on('pointermove', (e) => {
      if (!dragging) return
      world.position.x = worldStart.x + (e.global.x - dragStart.x)
      world.position.y = worldStart.y + (e.global.y - dragStart.y)
      writeViewportAttrs()
    })
    const stop = () => {
      dragging = false
    }
    app.stage.on('pointerup', stop)
    app.stage.on('pointerupoutside', stop)
    app.stage.on('wheel', (e) => {
      const dy = e.deltaY || 0
      const factor = dy < 0 ? 1.15 : 1 / 1.15
      const s = world.scale.x || 0.08
      const newS = Math.max(0.02, Math.min(8, s * factor))
      const f2 = newS / s
      const px = e.global.x
      const py = e.global.y
      // zoom-around-pointer: keep the world point under the pointer stationary
      world.position.x = px * (1 - f2) + world.position.x * f2
      world.position.y = py * (1 - f2) + world.position.y * f2
      world.scale.set(newS)
      writeViewportAttrs()
    })

    setStatus('ready', `dpr=${DPR} text=${TEXT_STRATEGY} culling=${CULLING} pool=${TEXTURE_POOL_SIZE}`)
    shell.setAttribute('data-culling-mode', CULLING)
    exposeRuntime()
  } catch (err) {
    setError(err?.message || String(err))
  }
}

const writeViewportAttrs = () => {
  shell.setAttribute('data-viewport-scale', String(Number(world.scale.x.toFixed(4))))
  shell.setAttribute('data-viewport-x', String(Math.round(world.position.x)))
  shell.setAttribute('data-viewport-y', String(Math.round(world.position.y)))
}

// --- fixture rendering ---
const clearWorld = () => {
  for (const child of createdNodes) {
    child.destroy({ children: true })
  }
  createdNodes = []
  world.removeChildren()
  world.position.set(0, 0)
  world.scale.set(1)
}

const renderFixture = (fixture) => {
  clearWorld()
  const nodes = fixture.snapshot.nodes
  let textRendered = 0
  let textSkipped = 0
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i]
    let view = null
    if (n.type === 'image') {
      const tex = texturePool[i % TEXTURE_POOL_SIZE]
      const sp = new Sprite(tex)
      sp.position.set(n.x, n.y)
      sp.width = n.width
      sp.height = n.height
      view = sp
    } else if (n.type === 'frame') {
      const g = new Graphics()
      const fill = hexToInt(n.sectionFillColor)
      const stroke = hexToInt(n.sectionBorderColor)
      g.rect(n.x, n.y, n.width, n.height)
        .fill({ color: fill, alpha: 0.9 })
        .stroke({ width: n.sectionBorderWidth || 2, color: stroke, alpha: 0.95 })
      view = g
    } else if (n.type === 'markup') {
      // connector / arrow: stroke a polyline. dashed style simplified to solid (recorded).
      const g = new Graphics()
      const stroke = hexToInt(n.markupStrokeColor)
      const pts = n.markupPoints || []
      const sx = n.x
      const sy = n.y
      g.moveTo(sx + (pts[0]?.x || 0), sy + (pts[0]?.y || 0))
      for (let k = 1; k < pts.length; k += 1) {
        g.lineTo(sx + pts[k].x, sy + pts[k].y)
      }
      g.stroke({ width: n.markupStrokeWidth || 2, color: stroke, alpha: n.markupOpacity ?? 1 })
      view = g
    } else if (n.type === 'text') {
      if (TEXT_STRATEGY === 'skip') {
        textSkipped += 1
        continue
      }
      const t = new Text({
        text: n.text || '',
        style: {
          fontFamily: 'system-ui, sans-serif',
          fontSize: n.fontSize || 18,
          fill: hexToInt(n.textColor),
          align: n.textAlign || 'left',
        },
      })
      t.resolution = 1
      t.position.set(n.x, n.y)
      view = t
      textRendered += 1
    }
    if (view) {
      view.eventMode = 'none'
      if (CULLING === 'on') {
        view.cullable = true
        // cullArea is in the child's LOCAL space (geometry drawn at 0,0..w,h), so the
        // culler can test against the screen rect without calling getBounds() each frame.
        view.cullArea = new Rectangle(0, 0, n.width, n.height)
      }
      world.addChild(view)
      createdNodes.push(view)
    }
  }

  // Use the fixture's recommendedViewport.scale so node on-screen size matches the 0b
  // Leafer/DOM baseline (the dominant factor for render cost). fit-view would scale 5k
  // nodes larger than 10k nodes and invert the ordering. Center the bounds in the
  // viewport for the start frame; pan/zoom deltas are unaffected by the exact offset.
  // Culling is OFF (all children drawn every frame) — matches 0b culling=off, the
  // hardest case; if Pixi clears 33ms here it clears the bar with room to spare.
  const rv = fixture.meta.recommendedViewport
  const b = fixture.meta.bounds
  const scale = rv && Number.isFinite(rv.scale) && rv.scale > 0 ? rv.scale : 1
  if (b && b.width > 0 && b.height > 0) {
    world.scale.set(scale)
    world.position.set(
      (VIEWPORT_W - b.width * scale) / 2 - b.x * scale,
      (VIEWPORT_H - b.height * scale) / 2 - b.y * scale,
    )
  }
  writeViewportAttrs()
  shell.setAttribute('data-total-node-count', String(fixture.meta.nodeCount))
  shell.setAttribute('data-pixi-children', String(world.children.length))
  return {
    nodeCount: fixture.meta.nodeCount,
    rendered: world.children.length,
    textRendered,
    textSkipped,
    texturePoolSize: TEXTURE_POOL_SIZE,
  }
}

// --- pixel non-empty evidence (mirrors collect.mjs leaferPixelNonEmpty gate) ---
// `renderer.extract.pixels` returned an empty result in Pixi v8.19 (the GPU stalled on
// ReadPixels but the typed array came back zero-length), so we read the WebGL framebuffer
// directly: force a render, then gl.readPixels a strided sample of the screen and count
// pixels that differ from the background clear color. One-shot, ~tens of ms even at 20k.
const samplePixelsNonEmpty = async () => {
  try {
    const gl = app.renderer.gl
    if (!gl) return { nonEmpty: false, samples: 0, error: 'no gl handle' }
    // render the current scene graph into the framebuffer, then read it back synchronously
    app.renderer.render(app.stage)
    const w = Math.min(VIEWPORT_W, app.canvas.width / DPR)
    const h = Math.min(VIEWPORT_H, app.canvas.height / DPR)
    const buf = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    if (!buf.length) return { nonEmpty: false, samples: 0 }
    let nonEmpty = false
    let samples = 0
    let contentPx = 0
    // stride scan (every 4th pixel) — fast and still proves the canvas isn't blank.
    for (let i = 0; i < buf.length; i += 16) {
      samples += 1
      const r = buf[i]
      const g = buf[i + 1]
      const b = buf[i + 2]
      if (Math.abs(r - BG_R) > 20 || Math.abs(g - BG_G) > 20 || Math.abs(b - BG_B) > 20) {
        contentPx += 1
        nonEmpty = true
      }
    }
    return { nonEmpty, samples, contentPx }
  } catch (err) {
    console.warn('[pixi-probe] pixel sample failed', err)
    return { nonEmpty: false, samples: 0, error: err?.message }
  }
}

// --- capture runtime (mirrors collect.mjs installBenchRuntime) ---
const captureState = { observer: undefined, capture: undefined }

const ensureObserver = () => {
  if (captureState.observer || typeof PerformanceObserver === 'undefined') return
  captureState.observer = new PerformanceObserver((list) => {
    if (!captureState.capture) return
    for (const entry of list.getEntries()) {
      captureState.capture.longTasks.push({
        startTime: entry.startTime,
        duration: entry.duration,
        name: entry.name,
      })
    }
  })
  captureState.observer.observe({ type: 'longtask', buffered: true })
}

const waitFrames = (count) =>
  new Promise((resolve) => {
    let remaining = count
    const tick = () => {
      remaining -= 1
      if (remaining <= 0) resolve()
      else window.requestAnimationFrame(tick)
    }
    window.requestAnimationFrame(tick)
  })

const exposeRuntime = () => {
  globalThis.__MIVO_PIXI_BENCH__ = {
    ready: true,
    textStrategy: TEXT_STRATEGY,
    dpr: DPR,
    texturePoolSize: TEXTURE_POOL_SIZE,
    async loadFixture(fixture) {
      setStatus('loading', `${fixture.meta.nodeCount} nodes`)
      const t0 = performance.now()
      const info = renderFixture(fixture)
      shell.setAttribute('data-pixi-load-ms', String(Math.round(performance.now() - t0)))
      setStatus('loaded', `${info.rendered}/${info.nodeCount} children`)
      return info
    },
    async waitForRender(fixture) {
      const expected = fixture.meta.nodeCount
      const startedAt = performance.now()
      // Pixi render is per-tick; settle = children count present + at least one frame
      // drawn + pixel non-empty. Poll up to 15s (parity with collect.mjs).
      let settled = false
      let pix = { nonEmpty: false, samples: 0 }
      while (performance.now() - startedAt < 15000) {
        const children = Number(shell.getAttribute('data-pixi-children') || 0)
        if (children >= expected - (fixture.meta.counts?.text || 0) || children > 0) {
          // give the ticker 4 frames to paint, then sample pixels
          await waitFrames(4)
          pix = await samplePixelsNonEmpty()
          shell.setAttribute('data-pixi-pixel-nonempty', String(pix.nonEmpty))
          shell.setAttribute('data-pixi-pixel-sample-count', String(pix.samples))
          if (pix.nonEmpty) {
            settled = true
            break
          }
        }
        await waitFrames(1)
      }
      setStatus('settled', `children=${shell.getAttribute('data-pixi-children')} px=${pix.nonEmpty ? 'Y' : 'N'}`)
      return {
        settled,
        totalNodeCount: expected,
        renderedChildren: Number(shell.getAttribute('data-pixi-children') || 0),
        pixelNonEmpty: pix.nonEmpty,
        pixelSampleCount: pix.samples,
        viewportScale: Number(shell.getAttribute('data-viewport-scale') || 0),
      }
    },
    startCapture(label) {
      ensureObserver()
      performance.clearMarks(label)
      performance.clearMarks(`${label}:start`)
      performance.clearMarks(`${label}:end`)
      const capture = {
        label,
        frames: [],
        longTasks: [],
        rafId: 0,
        active: true,
        lastFrameTs: undefined,
      }
      const sample = (timestamp) => {
        if (!capture.active) return
        if (capture.lastFrameTs != null) {
          capture.frames.push(timestamp - capture.lastFrameTs)
        }
        capture.lastFrameTs = timestamp
        capture.rafId = window.requestAnimationFrame(sample)
      }
      captureState.capture = capture
      performance.mark(label)
      performance.mark(`${label}:start`)
      capture.rafId = window.requestAnimationFrame(sample)
    },
    async stopCapture(label) {
      const capture = captureState.capture
      if (!capture || capture.label !== label) {
        throw new Error(`No active capture for ${label}`)
      }
      capture.active = false
      window.cancelAnimationFrame(capture.rafId)
      await waitFrames(2)
      performance.mark(`${label}:end`)
      performance.measure(label, `${label}:start`, `${label}:end`)
      captureState.capture = undefined
      return {
        label,
        durationMs: performance.getEntriesByName(label).at(-1)?.duration || 0,
        frames: capture.frames.filter((v) => Number.isFinite(v) && v > 0 && v < 1000),
        longTasks: capture.longTasks,
      }
    },
    getRenderState() {
      return {
        rendererMode: shell.getAttribute('data-renderer-mode'),
        cullingMode: shell.getAttribute('data-culling-mode'),
        totalNodeCount: Number(shell.getAttribute('data-total-node-count') || 0),
        pixiChildren: Number(shell.getAttribute('data-pixi-children') || 0),
        pixelNonEmpty: shell.getAttribute('data-pixi-pixel-nonempty') === 'true',
        pixelSampleCount: Number(shell.getAttribute('data-pixi-pixel-sample-count') || 0),
        viewportScale: Number(shell.getAttribute('data-viewport-scale') || 0),
        viewportX: Number(shell.getAttribute('data-viewport-x') || 0),
        viewportY: Number(shell.getAttribute('data-viewport-y') || 0),
        textStrategy: TEXT_STRATEGY,
        texturePoolSize: TEXTURE_POOL_SIZE,
        status: shell.getAttribute('data-pixi-status'),
      }
    },
    // Explicit teardown: destroy the app + children + textures + base textures so GPU
    // VRAM (uploaded textures, render targets) is released before the browser context
    // closes. Without this Pixi's GPU memory accumulates across runs in the same browser
    // process and eventually crashes the GPU process (observed at 10k run 2).
    async destroy() {
      try {
        if (app) {
          // stop the ticker so no render fires mid-destroy
          app.ticker.stop()
          if (world) {
            for (const child of createdNodes) child.destroy({ children: true, texture: true, baseTexture: true })
            createdNodes = []
            world.destroy({ children: true })
            world = null
          }
          for (const tex of texturePool) tex.destroy(true)
          texturePool.length = 0
          app.destroy(true, { children: true, texture: true, baseTexture: true })
          app = null
        }
      } catch (err) {
        console.warn('[pixi-probe] destroy failed', err)
      }
    },
  }
}

boot()
