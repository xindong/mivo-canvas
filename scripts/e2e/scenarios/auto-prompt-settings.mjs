// E2E scenario: first-login missing-key auto-prompt.
// Verifies the AutoPromptSettings flow: when auth hydrates to authenticated AND
// the settings store has neither key configured, the settings panel opens
// automatically and scrolls to the API Keys section; after the user closes it,
// the session flag suppresses a re-prompt (no re-open loop).
//
// SSO scheme: the dev BFF's /api/auth/me stub returns a fake logged-in user
// (NODE_ENV != production → stub active), so auth hydrates to authenticated
// without mocking /me. (The auto-prompt only reads auth status + settings keys.)
export const runAutoPromptSettingsScenario = async (context) => {
  const { baseUrl, page } = context

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('.project-sidebar')

  // Fresh browser context → IDB has no persisted keys → keysComplete=false.
  // AutoPrompt fires once auth hydrates (dev stub /me → authenticated) +
  // settings hydrate finishes (empty keys) → openSettings('api-keys').
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
