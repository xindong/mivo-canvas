// E2E scenario: UserChip (sidebar bottom) — the settings entry.
// SSO scheme: production forces login (gateway), so a user reaching the app is
// already authenticated. In dev e2e the BFF's /api/auth/me stub returns a fake
// logged-in user → UserChip shows the chip (initial-avatar + display_name).
// Clicking it opens the settings panel (which has the account/logout section).
// The unauthenticated "Log In" path (→ SSO gateway redirect) can't be exercised
// in local e2e (redirect leaves the app), so we assert the logged-in chip flow.
export const runUserChipScenario = async (context) => {
  const { baseUrl, page } = context
  // SSO dev stub → logged-in + no keys → AutoPromptSettings would auto-open the
  // panel + intercept the chip click. Suppress it (this scenario tests the chip, not the prompt).
  await page.addInitScript(() => { window.__MIVO_E2E_DISABLE_AUTO_PROMPT__ = true })
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('.project-sidebar')

  // F2 regression: old settings entry must be gone.
  const oldSettingsRow = await page.locator('.settings-row[aria-label="Settings"]').count()
  if (oldSettingsRow) throw new Error('old .settings-row Settings button should be deleted (F2)')
  const oldSettingsMenu = await page.locator('.settings-menu').count()
  if (oldSettingsMenu) throw new Error('old .settings-menu should be deleted (F2)')

  // Dev stub /me → authenticated → UserChip renders (.user-chip, not the Log In row).
  const chip = page.locator('.user-chip').first()
  await chip.waitFor()
  // The chip shows the dev stub user's display_name ("本地开发").
  await page.getByText('本地开发', { exact: false }).first().waitFor()

  // Click the chip → opens the settings panel.
  await chip.click()
  await page.waitForSelector('.settings-panel', { state: 'visible' })

  // Close the panel.
  await page.getByRole('button', { name: '关闭设置' }).click()
  await page.waitForSelector('.settings-panel', { state: 'detached' })
}
