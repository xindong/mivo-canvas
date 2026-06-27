type DemoImageOptions = {
  label: string
  accent: string
  secondary: string
  mood: 'character' | 'environment' | 'variant' | 'asset'
  seed: number
}

const imageCache = new Map<string, string>()

const seededRandom = (seed: number) => {
  let value = seed % 2147483647
  if (value <= 0) value += 2147483646
  return () => {
    value = (value * 16807) % 2147483647
    return (value - 1) / 2147483646
  }
}

const addNoise = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  seed: number,
) => {
  const random = seededRandom(seed)
  const imageData = ctx.getImageData(0, 0, width, height)
  const { data } = imageData

  for (let index = 0; index < data.length; index += 4) {
    const n = (random() - 0.5) * 18
    data[index] += n
    data[index + 1] += n
    data[index + 2] += n
  }

  ctx.putImageData(imageData, 0, 0)
}

const roundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

const drawCharacter = (
  ctx: CanvasRenderingContext2D,
  options: DemoImageOptions,
  random: () => number,
) => {
  const { accent, secondary } = options
  ctx.save()
  ctx.translate(160 + random() * 22, 105)

  ctx.fillStyle = 'rgba(255,255,255,0.66)'
  roundedRect(ctx, 80, 260, 155, 52, 18)
  ctx.fill()

  ctx.fillStyle = secondary
  roundedRect(ctx, 74, 114, 168, 230, 72)
  ctx.fill()

  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.ellipse(158, 108, 72, 88, -0.08, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(18, 22, 26, 0.88)'
  roundedRect(ctx, 92, 52, 132, 108, 48)
  ctx.fill()

  ctx.fillStyle = '#f3c7a2'
  ctx.beginPath()
  ctx.ellipse(158, 136, 54, 60, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(20, 24, 28, 0.9)'
  ctx.beginPath()
  ctx.ellipse(139, 130, 5, 7, 0, 0, Math.PI * 2)
  ctx.ellipse(177, 130, 5, 7, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = 'rgba(20, 24, 28, 0.58)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(158, 151, 16, 0.15, Math.PI - 0.15)
  ctx.stroke()

  ctx.fillStyle = 'rgba(255,255,255,0.34)'
  for (let i = 0; i < 26; i += 1) {
    const x = 42 + random() * 238
    const y = 22 + random() * 330
    ctx.fillRect(x, y, 2 + random() * 6, 2 + random() * 6)
  }

  ctx.restore()
}

const drawEnvironment = (
  ctx: CanvasRenderingContext2D,
  options: DemoImageOptions,
  random: () => number,
) => {
  const { accent, secondary } = options

  ctx.fillStyle = 'rgba(255,255,255,0.48)'
  ctx.beginPath()
  ctx.moveTo(0, 302)
  for (let x = 0; x <= 320; x += 18) {
    ctx.lineTo(x, 258 + random() * 46)
  }
  ctx.lineTo(320, 420)
  ctx.lineTo(0, 420)
  ctx.fill()

  ctx.fillStyle = secondary
  ctx.beginPath()
  ctx.moveTo(0, 244)
  for (let x = 0; x <= 320; x += 22) {
    ctx.lineTo(x, 168 + random() * 56)
  }
  ctx.lineTo(320, 420)
  ctx.lineTo(0, 420)
  ctx.fill()

  ctx.fillStyle = accent
  for (let i = 0; i < 9; i += 1) {
    const x = 28 + random() * 236
    const y = 96 + random() * 180
    roundedRect(ctx, x, y, 28 + random() * 44, 84 + random() * 96, 12)
    ctx.fill()
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.52)'
  ctx.lineWidth = 2
  for (let i = 0; i < 14; i += 1) {
    const x = 18 + random() * 284
    ctx.beginPath()
    ctx.moveTo(x, 44)
    ctx.lineTo(x + 18 - random() * 36, 360)
    ctx.stroke()
  }
}

const drawVariant = (
  ctx: CanvasRenderingContext2D,
  options: DemoImageOptions,
  random: () => number,
) => {
  const { accent, secondary } = options
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.beginPath()
  ctx.ellipse(160, 216, 116, 144, -0.08 + random() * 0.18, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = secondary
  ctx.beginPath()
  ctx.ellipse(160, 174, 92, 96, random() * 0.2, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = accent
  ctx.lineWidth = 12
  ctx.beginPath()
  ctx.arc(160, 198, 86, 0.2, Math.PI * 1.72)
  ctx.stroke()

  ctx.fillStyle = accent
  for (let i = 0; i < 18; i += 1) {
    ctx.beginPath()
    ctx.arc(70 + random() * 180, 70 + random() * 260, 3 + random() * 9, 0, Math.PI * 2)
    ctx.fill()
  }
}

const drawAsset = (
  ctx: CanvasRenderingContext2D,
  options: DemoImageOptions,
  random: () => number,
) => {
  const { accent, secondary } = options
  for (let i = 0; i < 7; i += 1) {
    ctx.fillStyle = i % 2 ? accent : secondary
    roundedRect(ctx, 34 + i * 27, 92 + random() * 22, 88, 220 - i * 16, 24)
    ctx.fill()
  }

  ctx.fillStyle = 'rgba(255,255,255,0.78)'
  roundedRect(ctx, 74, 266, 176, 68, 18)
  ctx.fill()
}

export const createDemoImage = (options: DemoImageOptions) => {
  const cacheKey = JSON.stringify(options)
  const cached = imageCache.get(cacheKey)
  if (cached) return cached

  const width = 320
  const height = 420
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const random = seededRandom(options.seed)
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, '#f6f1e7')
  gradient.addColorStop(0.44, options.secondary)
  gradient.addColorStop(1, '#26332f')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  ctx.globalAlpha = 0.16
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1
  for (let x = -40; x < width + 40; x += 28) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + 118, height)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  if (options.mood === 'character') drawCharacter(ctx, options, random)
  if (options.mood === 'environment') drawEnvironment(ctx, options, random)
  if (options.mood === 'variant') drawVariant(ctx, options, random)
  if (options.mood === 'asset') drawAsset(ctx, options, random)

  addNoise(ctx, width, height, options.seed)

  ctx.fillStyle = 'rgba(15, 18, 20, 0.72)'
  roundedRect(ctx, 18, 360, 284, 38, 13)
  ctx.fill()

  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = '600 18px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont'
  ctx.fillText(options.label, 34, 385)

  const dataUrl = canvas.toDataURL('image/jpeg', 0.78)
  imageCache.set(cacheKey, dataUrl)
  return dataUrl
}
