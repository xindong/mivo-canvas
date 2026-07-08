// E2E scenario: first-login missing-key auto-prompt (logged-in) + unauthenticated prompt.
//
// Flow 1 (logged-in): dev BFF's /api/auth/me stub returns a fake logged-in user
// (NODE_ENV != production → stub active) + fresh IDB has no keys → AutoPrompt
// opens the panel to the API Keys section; closing it suppresses re-prompt.
//
// Flow 2 (unauthenticated): mock /api/auth/me → 401 → AutoPrompt opens the panel
// to the ACCOUNT section (which shows a 「登录」 button — user clicks it to go to SSO,
// not auto-redirected). Tests the 用户实测 2026-07-08 unauthenticated branch.
export const runAutoPromptSettingsScenario = async (context) => {
  const { baseUrl, page } = context

  // Harness default suppresses AutoPrompt (window.__MIVO_E2E_DISABLE_AUTO_PROMPT__=true).
  // This scenario tests AutoPrompt → opt back in (our addInitScript runs after the
  // harness's, so false wins). Persists across both flows' reloads.
  await page.addInitScript(() => { window.__MIVO_E2E_DISABLE_AUTO_PROMPT__ = false })

  // ── Flow 1: logged-in + no keys → API Keys section ───────────────────────
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('.project-sidebar')

  // AutoPrompt fires once auth hydrates (dev stub → authenticated) + settings
  // hydrate (empty keys) → openSettings('api-keys').
  await page.waitForSelector('.settings-panel', { state: 'visible' })
  await page.waitForSelector('[data-section="api-keys"]')

  // Close the panel; the session-level autoPrompted flag must suppress re-prompt.
  await page.getByRole('button', { name: '关闭设置' }).click()
  await page.waitForSelector('.settings-panel', { state: 'detached' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const reopened = await page.locator('.settings-panel').count()
  if (reopened) {
    throw new Error('auto-prompt should NOT re-open after the user closed the panel this session')
  }

  // ── Flow 2: unauthenticated → account section (登录 button) ──────────────
  // Mock /me → 200 {authenticated:false} (a 401 mock would pollute the browser
  // console with "Failed to load resource 401" + trip the harness console-error
  // guard; the 401 branch itself is unit-tested in authClient.test.ts). fetchMe
  // treats this as unauthenticated → AutoPrompt opens the account section.
  // Reload re-arms autoPrompt (session flag is in-memory).
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, detail: 'Not authenticated' }),
    }),
  )
  await page.goto(baseUrl, { waitUntil: 'networkidle' })

  // AutoPrompt fires (unauthenticated) → openSettings('account').
  await page.waitForSelector('.settings-panel', { state: 'visible' })
  // Account section shows the 「登录」 button (not 登出) — user clicks to go to SSO.
  await page.getByRole('button', { name: '登录' }).waitFor()

  // Close the panel.
  await page.getByRole('button', { name: '关闭设置' }).click()
  await page.waitForSelector('.settings-panel', { state: 'detached' })
}
