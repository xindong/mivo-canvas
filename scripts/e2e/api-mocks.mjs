export const attachDefaultMivoApiMocks = async (page, { generatedImageB64, mivoEditRequests }) => {
  await page.route('**/api/mivo/generate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ images: [{ b64: generatedImageB64 }] }),
    })
  })

  await page.route('**/api/mivo/edit', async (route) => {
    const request = route.request()

    try {
      const formRequest = new Request('http://127.0.0.1/api/mivo/edit', {
        method: 'POST',
        headers: request.headers(),
        body: request.postDataBuffer(),
      })
      const formData = await formRequest.formData()
      mivoEditRequests.push({
        prompt: String(formData.get('prompt') || ''),
        fileKeys: ['image', 'mask', 'reference[]', 'reference']
          .map((key) => `${key}:${formData.getAll(key).length}`)
          .filter((entry) => !entry.endsWith(':0')),
      })
    } catch (error) {
      mivoEditRequests.push({
        prompt: '',
        fileKeys: [],
        parseError: error instanceof Error ? error.message : 'Unable to inspect edit request',
      })
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ images: [{ b64: generatedImageB64 }] }),
    })
  })

  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'generate',
        scene: 'general',
        reasoning: 'e2e',
        richPrompt: 'e2e derived concept image',
        imgRatio: '1:1',
        quality: 'medium',
        enhanced: true,
      }),
    })
  })
}
