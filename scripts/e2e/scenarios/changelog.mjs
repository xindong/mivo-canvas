// 更新日志入口/面板轻量场景:
// ① 入口按钮位于 Debug Log 正上方 ② 未读红点显示、打开面板后消失
// ③ 面板按天双列布局("✨ 新功能"/"🔧 修复的问题") ④ 开关面板不破坏 Debug Log 与 Settings 交互
// changelog.json 用路由 mock 固定数据,避免真实文件超出 7 天窗口后场景失效。

// 与 src/lib/changelogDate.ts 的 toChangelogDay 同语义:时间轴左移 8h 后取本地日历日。
const toChangelogDay = (ts) => {
  const shifted = new Date(ts - 8 * 3_600_000)
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const day = String(shifted.getDate()).padStart(2, '0')
  return `${shifted.getFullYear()}-${month}-${day}`
}

export const runChangelogScenario = async (context) => {
  const { baseUrl, canvasUrl, page } = context

  const today = toChangelogDay(Date.now())
  const fixture = {
    lastGithash: 'e2e-fixture',
    updatedAt: '2099-01-01T12:00:00+08:00',
    entries: [
      {
        date: today,
        prs: [9001],
        // 新 schema {text, by} + 一条旧版纯 string(向后兼容:无作者标签渲染)
        features: [
          { text: 'e2e-changelog 新功能条目', by: 'E2E Author' },
          'e2e-changelog 旧格式条目',
        ],
        fixes: [{ text: 'e2e-changelog 修复条目', by: 'E2E Author' }],
      },
    ],
  }
  await page.route('**/changelog.json*', (route) => {
    void route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) })
  })

  // 一次性清 storage 后 reload(不用 addInitScript:它每次导航都清,会把后面
  // "已读状态跨 reload 保持/updatedAt 变化红点重亮"的断言洗掉)。
  await page.goto(canvasUrl || baseUrl, { waitUntil: 'networkidle' })
  await page.evaluate(() => {
    try { window.localStorage.clear() } catch { /* opaque origin */ }
    try { window.sessionStorage.clear() } catch { /* opaque origin */ }
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')

  // ① 入口唯一且位于 Debug Log 正上方
  const changelogButton = page.getByRole('button', { name: 'Changelog', exact: true })
  if ((await changelogButton.count()) !== 1) {
    throw new Error('Project sidebar should expose one Changelog button')
  }
  const placement = await page.evaluate(() => {
    const changelog = document.querySelector('[aria-label="Changelog"]')?.getBoundingClientRect()
    const debugLog = document.querySelector('[aria-label="Debug Log"]')?.getBoundingClientRect()
    return { changelogBottom: changelog?.bottom, debugLogTop: debugLog?.top }
  })
  if (
    typeof placement.changelogBottom !== 'number' ||
    typeof placement.debugLogTop !== 'number' ||
    placement.changelogBottom > placement.debugLogTop
  ) {
    throw new Error(`Changelog entry should sit directly above Debug Log: ${JSON.stringify(placement)}`)
  }

  // ② 未读红点:localStorage 清空 + fixture updatedAt → 必有未读
  await page.waitForSelector('[aria-label="Changelog"] .changelog-badge-dot')

  // ③ 打开面板:按天双列布局
  await changelogButton.click()
  await page.getByRole('dialog', { name: '更新日志' }).waitFor()
  const dayLayout = await page.evaluate(() => {
    const day = document.querySelector('.changelog-day')
    const columns = day ? day.querySelectorAll('.changelog-column') : []
    return {
      hasDay: Boolean(day),
      columnCount: columns.length,
      columnTitles: Array.from(columns).map((column) => column.querySelector('h4')?.textContent ?? ''),
    }
  })
  if (
    !dayLayout.hasDay ||
    dayLayout.columnCount !== 2 ||
    dayLayout.columnTitles[0] !== '✨ 新功能' ||
    dayLayout.columnTitles[1] !== '🔧 修复的问题'
  ) {
    throw new Error(`Changelog panel should render per-day two-column layout: ${JSON.stringify(dayLayout)}`)
  }
  await page.getByText('e2e-changelog 新功能条目').waitFor()
  await page.getByText('e2e-changelog 修复条目').waitFor()

  // ③ 续:作者名灰字标签——新 schema 条目带 by 标签,旧 string 条目无标签
  const authorTags = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.changelog-day li'))
    return items.map((item) => ({
      text: item.textContent ?? '',
      byTag: item.querySelector('.changelog-item-by')?.textContent ?? null,
    }))
  })
  const withAuthor = authorTags.filter((item) => item.byTag === 'E2E Author')
  const legacyItem = authorTags.find((item) => item.text.includes('旧格式条目'))
  if (withAuthor.length !== 2 || !legacyItem || legacyItem.byTag !== null) {
    throw new Error(`Changelog items should show contributor tags (legacy strings without): ${JSON.stringify(authorTags)}`)
  }

  // ② 续:打开即已读,红点消失
  await page.waitForSelector('[aria-label="Changelog"] .changelog-badge-dot', { state: 'detached' })

  // 关闭面板
  await page.getByRole('button', { name: '关闭更新日志' }).click()
  await page.waitForSelector('.changelog-panel', { state: 'detached' })

  // ④ Debug Log 不受影响,且记录了打开日志
  await page.getByRole('button', { name: 'Debug Log', exact: true }).click()
  await page.locator('.debug-log-panel').waitFor()
  await page.getByText('Changelog panel opened').first().waitFor()
  await page.getByRole('button', { name: 'Close debug log' }).click()
  await page.waitForSelector('.debug-log-panel', { state: 'detached' })

  // ④ 续:Settings 菜单开合正常
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
  await settingsButton.click()
  await page.locator('.settings-menu').waitFor()
  await settingsButton.click()
  await page.waitForSelector('.settings-menu', { state: 'detached' })

  // 已读后再开面板,关闭后红点保持消失
  await changelogButton.click()
  await page.getByRole('dialog', { name: '更新日志' }).waitFor()
  await page.getByRole('button', { name: '关闭更新日志' }).click()
  await page.waitForSelector('.changelog-panel', { state: 'detached' })
  if (await page.locator('[aria-label="Changelog"] .changelog-badge-dot').count()) {
    throw new Error('Changelog badge dot should stay cleared after reading')
  }

  // 已读状态跨 reload 保持:updatedAt 不变时红点不重亮
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
  await page.getByRole('button', { name: 'Changelog', exact: true }).waitFor()
  if (await page.locator('[aria-label="Changelog"] .changelog-badge-dot').count()) {
    throw new Error('Changelog badge dot should stay cleared across reload when updatedAt is unchanged')
  }

  // 同日追加场景:仅 updatedAt 变化(entries 同日追加)→ 红点重新点亮
  fixture.updatedAt = '2099-02-02T12:00:00+08:00'
  fixture.entries[0].fixes = [...fixture.entries[0].fixes, 'e2e-changelog 同日追加的修复条目']
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
  await page.waitForSelector('[aria-label="Changelog"] .changelog-badge-dot')

  await page.unroute('**/changelog.json*')
}
