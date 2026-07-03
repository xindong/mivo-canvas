import { Buffer } from 'node:buffer'

export const assertProdPublicRestrictions = async ({ baseUrl, authedFetch }) => {
  const localAssetsDisabled = await authedFetch(`${baseUrl}/api/mivo/local-assets`)
  if (localAssetsDisabled.status !== 404) {
    throw new Error(`prod security: local-assets should default 404 in public mode, got ${localAssetsDisabled.status}`)
  }

  const eagleDisabled = await authedFetch(`${baseUrl}/api/mivo/eagle/status`)
  if (eagleDisabled.status !== 404) {
    throw new Error(`prod security: eagle should default 404 in public mode, got ${eagleDisabled.status}`)
  }

  const debugViewDenied = await authedFetch(`${baseUrl}/api/mivo/debug-logs`)
  if (debugViewDenied.status !== 403) {
    throw new Error(`prod security: debug GET without debug token should 403, got ${debugViewDenied.status}`)
  }
}

export const assertProdUnauthorizedGate = async ({ requestContext, baseUrl }) => {
  const nakedGenerate = await requestContext.post(`${baseUrl}/api/mivo/generate`, {
    data: { prompt: 'auth smoke', model: 'doubao-seedance-2-0-fast-260128' },
  })
  if (nakedGenerate.status() !== 401) {
    throw new Error(`prod security: bare generate request should 401, got ${nakedGenerate.status()}`)
  }
}

export const assertProdAuthorizedChain = async ({
  requestContext,
  baseUrl,
  localAssetFixtureSvg,
}) => {
  const generateResponse = await requestContext.post(`${baseUrl}/api/mivo/generate`, {
    data: { prompt: 'prod token generate', model: 'doubao-seedance-2-0-fast-260128' },
  })
  const generateBody = await generateResponse.json()
  if (!generateResponse.ok() || !Array.isArray(generateBody.images) || generateBody.images.length !== 1) {
    throw new Error(`prod auth chain: generate should 200 with token, got ${JSON.stringify(generateBody)}`)
  }

  const editResponse = await requestContext.fetch(`${baseUrl}/api/mivo/edit`, {
    method: 'POST',
    multipart: {
      image: {
        name: 'prod-e2e.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(localAssetFixtureSvg),
      },
      prompt: 'prod token edit',
      model: 'doubao-seedance-2-0-fast-260128',
    },
  })
  const editBody = await editResponse.json()
  if (!editResponse.ok() || !Array.isArray(editBody.images) || editBody.images.length !== 1) {
    throw new Error(`prod auth chain: edit should 200 with token, got ${JSON.stringify(editBody)}`)
  }

  const enhanceResponse = await requestContext.post(`${baseUrl}/api/mivo/enhance`, {
    data: { prompt: 'prod token enhance' },
  })
  const enhanceBody = await enhanceResponse.json()
  if (!enhanceResponse.ok() || enhanceBody.enhanced !== true) {
    throw new Error(`prod auth chain: enhance should 200 with token, got ${JSON.stringify(enhanceBody)}`)
  }

  const debugPostResponse = await requestContext.post(`${baseUrl}/api/mivo/debug-logs`, {
    data: {
      clientId: 'prod-e2e',
      sessionId: 'prod-e2e',
      entries: [{ level: 'warning', source: 'prod-e2e', message: 'prod token', timestamp: Date.now() }],
    },
  })
  const debugPostBody = await debugPostResponse.json()
  if (!debugPostResponse.ok() || debugPostBody.ok !== true) {
    throw new Error(`prod auth chain: debug POST should 200 with token, got ${JSON.stringify(debugPostBody)}`)
  }

  const authedLocalAssets = await requestContext.get(`${baseUrl}/api/mivo/local-assets`)
  const authedLocalAssetsBody = await authedLocalAssets.json()
  if (!authedLocalAssets.ok() || !Array.isArray(authedLocalAssetsBody.assets) || authedLocalAssetsBody.assets.length < 1) {
    throw new Error(`prod auth chain: local-assets should 200 with token, got ${JSON.stringify(authedLocalAssetsBody)}`)
  }

  const authedEagle = await requestContext.get(`${baseUrl}/api/mivo/eagle/status`)
  const authedEagleBody = await authedEagle.json()
  if (!authedEagle.ok() || authedEagleBody.connected !== true) {
    throw new Error(`prod auth chain: eagle status should 200 connected=true with token, got ${JSON.stringify(authedEagleBody)}`)
  }
}
