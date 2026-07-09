// E2E scenario: UserChip (sidebar bottom) — the settings entry.
// SSO scheme: production forces login (gateway), so a user reaching the app is
// already authenticated. In dev e2e the BFF's /api/auth/me stub returns a fake
// logged-in user (P1-b opt-in: harness sets MIVO_DEV_AUTH_STUB=1) → UserChip shows
// the chip (initial-avatar + display_name).
// Clicking it opens the settings panel (which has the account/logout section).
// The unauthenticated "Settings" row must open account settings first. The panel's
// own 「登录」 button is the only control that redirects to SSO.
export const runUserChipScenario = async (context) => {
  const { baseUrl, page } = context
  // AutoPrompt suppression is the harness default (createSmokePage); this scenario
  // tests the chip, not the prompt, so no opt-in needed.
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('.project-sidebar')

  // F2 regression: the old popover menu is gone. The unauthenticated account entry
  // is intentionally named "Settings" again, so this no longer bans that row label.
  const oldSettingsMenu = await page.locator('.settings-menu').count()
  if (oldSettingsMenu) throw new Error('old .settings-menu should be deleted (F2)')

  // Dev stub /me → authenticated → UserChip renders (.user-chip, not the Settings row).
  const chip = page.locator('.user-chip').first()
  await chip.waitFor()
  // The chip shows the dev stub user's display_name ("朱赞（本地）").
  await page.getByText('朱赞（本地）', { exact: false }).first().waitFor()

  // Click the chip → opens the settings panel.
  await chip.click()
  await page.waitForSelector('.settings-panel', { state: 'visible' })

  // Close the panel.
  await page.getByRole('button', { name: '关闭设置' }).click()
  await page.waitForSelector('.settings-panel', { state: 'detached' })

  // Mock /me → unauthenticated. HUD "Settings" must open settings, not redirect.
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, detail: 'Not authenticated' }),
    }),
  )
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('.project-sidebar')

  const settingsRow = page.getByRole('button', { name: 'Settings' })
  await settingsRow.waitFor()
  const urlBeforeClick = page.url()
  await settingsRow.click()
  await page.waitForSelector('.settings-panel', { state: 'visible' })
  if (page.url() !== urlBeforeClick) {
    throw new Error(`HUD Settings should open settings without SSO redirect: before=${urlBeforeClick} after=${page.url()}`)
  }

  await page.getByRole('button', { name: /^登录$/ }).waitFor()
  await page.getByText('请先登录 SSO 后再配置 API Keys').waitFor()
  await page.getByRole('button', { name: '去登录' }).waitFor()
  if ((await page.getByText('XD 网关 Key', { exact: true }).count()) !== 0) {
    throw new Error('unauthenticated settings should hide the XD gateway key row')
  }
  if ((await page.getByText('Mivo Key', { exact: true }).count()) !== 0) {
    throw new Error('unauthenticated settings should hide the Mivo key row')
  }
}
