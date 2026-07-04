// server/__tests__/mockUpstream.ts
// Local HTTP fixture server emulating the mivo platform + llm-proxy upstreams.
// Used by p1c.test.ts to exercise code-derived scenarios (platform chain, 401
// retry, single-flight, poll timeout, 4xx/5xx passthrough, 413, timeouts, degrade).
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'

export type MockState = {
  // call counters
  tokenCalls: number
  chatCalls: number
  submitCalls: number
  pollCalls: number
  signUrlCalls: number
  uploadCalls: number
  downloadCalls: number
  generateCalls: number
  editCalls: number
  enhanceCalls: number
  lastEditBodyText: string
  lastEnhanceBodyText: string
  // configurable responses
  tokenStatus: number
  chatStatus: number
  chat401Once: boolean
  submitStatus: number
  submitStatusSequence: number[]
  pollFailMode: 'none' | '401-once' | '401-always'
  pollSequence: string[]
  pollImages: string[]
  pollError: string
  signUrlBody: string | null
  downloadStatus: number
  downloadStatusSequence: number[]
  downloadBody: Buffer
  downloadUrl: string
  downloadDelayMs: number
  uploadStatus: number
  uploadId: string
  generateStatus: number
  generateBody: unknown
  generateDelayMs: number
  editStatus: number
  editBody: unknown
  enhanceStatus: number
  enhanceBody: unknown
  enhanceDelayMs: number
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x45, 0x4e, 0x44,
])

export const defaultMockState = (): MockState => ({
  tokenCalls: 0,
  chatCalls: 0,
  submitCalls: 0,
  pollCalls: 0,
  signUrlCalls: 0,
  uploadCalls: 0,
  downloadCalls: 0,
  generateCalls: 0,
  editCalls: 0,
  enhanceCalls: 0,
  lastEditBodyText: '',
  lastEnhanceBodyText: '',
  tokenStatus: 200,
  chatStatus: 200,
  chat401Once: false,
  submitStatus: 200,
  submitStatusSequence: [],
  pollFailMode: 'none',
  pollSequence: ['pending', 'completed'],
  pollImages: ['/dl/img-1'],
  pollError: 'platform boom',
  signUrlBody: null,
  downloadStatus: 200,
  downloadStatusSequence: [],
  downloadBody: PNG_BYTES,
  downloadUrl: '',
  downloadDelayMs: 0,
  uploadStatus: 200,
  uploadId: 'img-1',
  generateStatus: 200,
  generateBody: { data: [{ b64_json: Buffer.from('gen-bytes').toString('base64') }] },
  generateDelayMs: 0,
  editStatus: 200,
  editBody: { data: [{ b64_json: Buffer.from('edit-bytes').toString('base64') }] },
  enhanceStatus: 200,
  enhanceBody: {
    choices: [
      {
        message: {
          content:
            '{"mode":"generate","scene":"scene","reasoning":"reasoning","richPrompt":"rich","imgRatio":"1:1","quality":"medium"}',
        },
      },
    ],
  },
  enhanceDelayMs: 0,
})

const send = (
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType = 'application/json',
): void => {
  res.statusCode = status
  res.setHeader('Content-Type', contentType)
  if (typeof body === 'string') res.end(body)
  else if (Buffer.isBuffer(body)) res.end(body)
  else res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

async function handle(state: MockState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method || 'GET'

  if (path === '/api/v1/state/token' && method === 'POST') {
    state.tokenCalls += 1
    if (state.tokenStatus !== 200) {
      send(res, state.tokenStatus, {})
      return
    }
    send(res, 200, { session: 'tok-1' })
    return
  }
  if (path === '/api/v1/message/chat' && method === 'POST') {
    state.chatCalls += 1
    if (state.chat401Once && state.chatCalls === 1) {
      send(res, 401, { error: 'bad token' })
      return
    }
    if (state.chatStatus !== 200) {
      send(res, state.chatStatus, {})
      return
    }
    send(res, 200, { object_id: 'chat-1' })
    return
  }
  if (path === '/api/v1/message' && method === 'POST') {
    state.submitCalls += 1
    const submitStatus = state.submitStatusSequence[state.submitCalls - 1] ?? state.submitStatus
    if (submitStatus !== 200) {
      send(res, submitStatus, {})
      return
    }
    send(res, 200, { object_id: 'job-1' })
    return
  }
  const pollMatch = path.match(/^\/api\/v1\/message\/([^/]+)$/)
  if (pollMatch && method === 'GET') {
    state.pollCalls += 1
    if (state.pollFailMode === '401-once' && state.pollCalls === 1) {
      send(res, 401, { error: 'bad token' })
      return
    }
    if (state.pollFailMode === '401-always') {
      send(res, 401, { error: 'bad token' })
      return
    }
    const idx = Math.min(state.pollCalls - 1, state.pollSequence.length - 1)
    const status = state.pollSequence[idx] ?? 'pending'
    if (status === 'completed') {
      send(res, 200, { content: { status: 'completed', images: state.pollImages } })
      return
    }
    if (status === 'failed') {
      send(res, 200, { content: { status: 'failed', error: state.pollError } })
      return
    }
    send(res, 200, { content: { status: 'pending' } })
    return
  }
  const signMatch = path.match(/^\/api\/v1\/file\/signUrl\/(.+)$/)
  if (signMatch && method === 'GET') {
    state.signUrlCalls += 1
    const body = state.signUrlBody ?? `${state.downloadUrl}/dl/${state.uploadId}`
    send(res, 200, body, 'text/plain')
    return
  }
  if (path === '/api/v1/file/' && method === 'POST') {
    state.uploadCalls += 1
    await readBody(req)
    if (state.uploadStatus !== 200) {
      send(res, state.uploadStatus, {})
      return
    }
    send(res, 200, [{ object_id: state.uploadId }])
    return
  }
  if (path.startsWith('/dl/') && method === 'GET') {
    state.downloadCalls += 1
    if (state.downloadDelayMs) await new Promise((r) => setTimeout(r, state.downloadDelayMs))
    const downloadStatus = state.downloadStatusSequence[state.downloadCalls - 1] ?? state.downloadStatus
    if (downloadStatus !== 200) {
      send(res, downloadStatus, '', 'image/png')
      return
    }
    send(res, 200, state.downloadBody, 'image/png')
    return
  }
  if (path === '/v1/images/generations' && method === 'POST') {
    state.generateCalls += 1
    if (state.generateDelayMs) await new Promise((r) => setTimeout(r, state.generateDelayMs))
    if (state.generateStatus !== 200) {
      send(res, state.generateStatus, { error: { message: 'generate failed' } })
      return
    }
    send(res, 200, state.generateBody)
    return
  }
  if (path === '/v1/images/edits' && method === 'POST') {
    state.editCalls += 1
    state.lastEditBodyText = (await readBody(req)).toString('utf8')
    if (state.editStatus !== 200) {
      send(res, state.editStatus, { error: { message: 'edit failed' } })
      return
    }
    send(res, 200, state.editBody)
    return
  }
  if (path === '/v1/chat/completions' && method === 'POST') {
    state.enhanceCalls += 1
    state.lastEnhanceBodyText = (await readBody(req)).toString('utf8')
    if (state.enhanceDelayMs) await new Promise((r) => setTimeout(r, state.enhanceDelayMs))
    if (state.enhanceStatus !== 200) {
      send(res, state.enhanceStatus, { error: { message: 'enhance failed' } })
      return
    }
    send(res, 200, state.enhanceBody)
    return
  }

  res.statusCode = 404
  res.end('not found')
}

export const startMockUpstream = (state: MockState): Promise<{ server: Server; url: string }> =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      handle(state, req, res).catch((err) => {
        if (!res.headersSent) res.statusCode = 500
        res.end(`mock error: ${err instanceof Error ? err.message : String(err)}`)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
