// E2E scenario: first-login missing-key auto-prompt.
// Verifies the AutoPromptSettings flow: when auth hydrates to authenticated AND
// the settings store has neither key configured, the settings panel opens
// automatically and scrolls to the API Keys section; after the user closes it,
// the session flag suppresses a re-prompt (no re-open loop).
//
// dev BFF has no JWT_SECRET and MIVO_DEV_AUTH_ENABLED is unset, so real Feishu
// OAuth / dev-login won't yield an authenticated session. We mock /api/auth/me
// to simulate a hydrated authenticated user (the auto-prompt only reads auth
// status + settings keys, so mocking the hydrate response is sufficient).
export const runAutoPromptSettingsScenario = async (context) => {
  const { baseUrl, page } = context

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'e2e-auto-prompt', name: 'E2E Auto Prompt', avatar: null },
      }),
    }),
  )

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('.project-sidebar')

  // Fresh browser context → IDB has no persisted keys → keysComplete=false.
  // AutoPrompt fires once auth hydrates (authenticated) + settings hydrate
  // finishes (empty keys) → openSettings('api-keys').
  await page.waitForSelector('.settings-panel', { state: 'visible' })
  await page.waitForSelector('[data-section="api-keys"]')

  // Close the panel; the session-level autoPrompted flag must suppress re-prompt.
  await page.getByRole('button', { name: '关闭设置' }).click()
  await page.waitForSelector('.settings-panel', { state: 'detached' })
  // Give the effect a tick to (not) re-fire.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const reopened = await page.locator('.settings-panel').count()
  if (reopened) {
    throw new Error('auto-prompt should NOT re-open after the user closed the panel this session')
  }
}
