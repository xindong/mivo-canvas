// E2E scenario: UserChip (sidebar bottom) — the new settings entry.
// F2 regression guard: the old .settings-row Settings button + .settings-menu
// were deleted and replaced by UserChip. Stub auth state shows a "Log In" row;
// clicking it must not crash and must surface a debug log entry (the not-yet-
// implemented login path is observable per docs/development-logging.md).
export const runUserChipScenario = async (context) => {
  const { baseUrl, page } = context
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('.project-sidebar')

  // F2 regression: old settings entry must be gone.
  const oldSettingsRow = await page.locator('.settings-row[aria-label="Settings"]').count()
  if (oldSettingsRow) throw new Error('old .settings-row Settings button should be deleted (F2)')
  const oldSettingsMenu = await page.locator('.settings-menu').count()
  if (oldSettingsMenu) throw new Error('old .settings-menu should be deleted (F2)')

  // Stub auth (E2) → "Log In" row (reuses .settings-row, aria-label="Log in").
  const loginRow = page.getByRole('button', { name: 'Log in', exact: true })
  await loginRow.waitFor()
  await loginRow.click()

  // Stub login() only emits a debugLogger.warn — verify it landed in the Debug
  // Log so the not-implemented path is observable.
  await page.getByRole('button', { name: 'Debug Log', exact: true }).click()
  await page.locator('.debug-log-panel').waitFor()
  await page.getByText('login() called on E2 stub', { exact: false }).first().waitFor()
  await page.getByRole('button', { name: 'Close debug log' }).click()
  await page.waitForSelector('.debug-log-panel', { state: 'detached' })
}
