// E2E scenario: UserChip (sidebar bottom) — the settings entry.
// SSO scheme: production forces login (gateway), so a user reaching the app is
// already authenticated. In dev e2e the BFF's /api/auth/me stub returns a fake
// logged-in user (P1-b opt-in: harness sets MIVO_DEV_AUTH_STUB=1) → UserChip shows
// the chip (initial-avatar + display_name).
// Clicking it opens the settings panel (which has the account/logout section).
// The unauthenticated "Settings" row must open account settings first. The panel's
// own 「登录」 button is the only control that redirects to SSO.
export const runUserChipScenario = async (context) => {
  const { baseUrl, page, isProdTopology } = context
  // AutoPrompt suppression is the harness default (createSmokePage); this scenario
  // tests the chip, not the prompt, so no opt-in needed.
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('.project-sidebar')

  // F2 regression: the old popover menu is gone. The unauthenticated account entry
  // is intentionally named "Settings" again, so this no longer bans that row label.
  const oldSettingsMenu = await page.locator('.settings-menu').count()
  if (oldSettingsMenu) throw new Error('old .settings-menu should be deleted (F2)')

  // Dev stub /me → authenticated → UserChip renders (.user-chip, not the Settings row).
  // prod 拓扑 createSmokePage 设 mockAuthMe(e2e-smoke.mjs:291)→ /api/auth/me 返
  // {authenticated:false}(代表"无 SSO 会话的未登录态"),UserChip 不渲染 .user-chip 而显
  // "Settings" 行 → :23 waitFor 超时(nightly-e2e 全扫红灯)。prod skip 认证 chip 流(遵
  // mask-multi-edit:377 既有 dev-only 机制守卫范式 + development-logging 哲学:不静默跳);
  // 后半段未认证 settings/SSO 流(:35-63,prod-relevant)两拓扑照常跑。
  if (!isProdTopology) {
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
  } else {
    console.log('[userchip] prod: authenticated-chip flow skipped (dev-only MIVO_DEV_AUTH_STUB /me → authenticated; prod mocks /me unauthenticated so .user-chip does not render); unauthenticated settings/SSO flow still runs')
  }

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
