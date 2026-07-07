// E2E scenario: UserChip (sidebar bottom) — the new settings entry.
// F2 regression guard: the old .settings-row Settings button + .settings-menu
// were deleted and replaced by UserChip. Unauthenticated state shows a "Log In"
// row; clicking it triggers the REAL login() flow (GET /api/auth/login-url).
// In the dev e2e env the BFF has no JWT_SECRET, so login-url returns 503 and
// login() surfaces an observable "登录启动失败" error log (per
// docs/development-logging.md). We assert that failure path is observable, not a
// crash — the logged-in success path (302 to Feishu) needs a configured auth env
// + ops callback allowlist and is out of scope for local e2e.
export const runUserChipScenario = async (context) => {
  const { baseUrl, page } = context
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('.project-sidebar')

  // F2 regression: old settings entry must be gone.
  const oldSettingsRow = await page.locator('.settings-row[aria-label="Settings"]').count()
  if (oldSettingsRow) throw new Error('old .settings-row Settings button should be deleted (F2)')
  const oldSettingsMenu = await page.locator('.settings-menu').count()
  if (oldSettingsMenu) throw new Error('old .settings-menu should be deleted (F2)')

  // Unauthenticated → "Log In" row (reuses .settings-row, aria-label="Log in").
  const loginRow = page.getByRole('button', { name: 'Log in', exact: true })
  await loginRow.waitFor()
  await loginRow.click()

  // Real login() calls /api/auth/login-url; dev BFF (no JWT_SECRET) → 503, so
  // login() logs a debugLogger.error. Verify it landed in the Debug Log so the
  // failure path is observable (getByText retries, tolerating the async fetch).
  await page.getByRole('button', { name: 'Debug Log', exact: true }).click()
  await page.locator('.debug-log-panel').waitFor()
  await page.getByText('登录启动失败', { exact: false }).first().waitFor()
  await page.getByRole('button', { name: 'Close debug log' }).click()
  await page.waitForSelector('.debug-log-panel', { state: 'detached' })
}
