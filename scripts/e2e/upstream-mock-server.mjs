import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

const json = (response, status, body) => {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x45, 0x4e, 0x44,
])

export const startUpstreamMockServer = async ({ generatedImageB64 }) => {
  const imagePayload = generatedImageB64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')

    if (requestUrl.pathname === '/v1/images/generations' && request.method === 'POST') {
      json(response, 200, { data: [{ b64_json: imagePayload }] })
      return
    }

    if (requestUrl.pathname === '/v1/images/edits' && request.method === 'POST') {
      json(response, 200, { data: [{ b64_json: imagePayload }] })
      return
    }

    if (requestUrl.pathname === '/v1/chat/completions' && request.method === 'POST') {
      json(response, 200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                mode: 'generate',
                scene: 'general',
                reasoning: 'mock upstream',
                richPrompt: 'mock upstream concept render',
                imgRatio: '1:1',
                quality: 'medium',
              }),
            },
          },
        ],
      })
      return
    }

    if (requestUrl.pathname.startsWith('/dl/') && request.method === 'GET') {
      response.statusCode = 200
      response.setHeader('Content-Type', 'image/png')
      response.end(pngBytes)
      return
    }

    response.statusCode = 404
    response.end('not found')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()

  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    port: typeof address === 'object' && address ? address.port : 0,
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
  }
}
