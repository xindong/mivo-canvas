import path from 'node:path'
import { createServer } from 'node:http'

export const startEagleMockServer = async ({ eagleMockDir, eagleMockItem, eagleMockItemDir }) => {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')

    if (requestUrl.pathname === '/api/application/info') {
      response.end(JSON.stringify({ status: 'success', data: { version: 'E2E', platform: 'darwin' } }))
      return
    }

    if (requestUrl.pathname === '/api/library/info') {
      response.end(
        JSON.stringify({
          status: 'success',
          data: {
            folders: [{ id: 'MOCK-FOLDER', name: 'Mock Eagle Folder', children: [] }],
            libPath: eagleMockDir,
          },
        }),
      )
      return
    }

    if (requestUrl.pathname === '/api/folder/list') {
      response.end(
        JSON.stringify({
          status: 'success',
          data: [{ id: 'MOCK-FOLDER', name: 'Mock Eagle Folder', children: [] }],
        }),
      )
      return
    }

    if (requestUrl.pathname === '/api/tag/list') {
      response.end(
        JSON.stringify({
          status: 'success',
          data: [
            { id: 'mock', name: 'mock', count: 1 },
            { id: 'eagle', name: 'eagle', count: 1 },
          ],
        }),
      )
      return
    }

    if (requestUrl.pathname === '/api/item/list') {
      const folderId = requestUrl.searchParams.get('folderId')
      const keyword = requestUrl.searchParams.get('keyword')?.toLowerCase() || ''
      const tag = requestUrl.searchParams.get('tags')?.toLowerCase() || ''
      const matchesFolder = !folderId || folderId === 'MOCK-FOLDER'
      const matchesKeyword = !keyword || eagleMockItem.name.toLowerCase().includes(keyword)
      const matchesTag = !tag || eagleMockItem.tags.some((itemTag) => itemTag.toLowerCase() === tag)
      response.end(
        JSON.stringify({
          status: 'success',
          data: matchesFolder && matchesKeyword && matchesTag ? [eagleMockItem] : [],
        }),
      )
      return
    }

    if (requestUrl.pathname === '/api/item/info') {
      response.end(JSON.stringify({ status: 'success', data: eagleMockItem }))
      return
    }

    if (requestUrl.pathname === '/api/item/thumbnail') {
      response.end(
        JSON.stringify({
          status: 'success',
          data: path.join(eagleMockItemDir, 'Mock Eagle Concept_thumbnail.svg'),
        }),
      )
      return
    }

    response.statusCode = 404
    response.end(JSON.stringify({ status: 'error', message: 'not found' }))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()

  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    port: typeof address === 'object' && address ? address.port : 41895,
    server,
  }
}
