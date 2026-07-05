// 更新日志入口/面板轻量场景:
// ① 入口按钮位于 Debug Log 正上方 ② 未读红点显示、打开面板后消失
// ③ 面板按天轮播+双列作者分组 ④ 开关面板不破坏 Debug Log 与 Settings 交互
// changelog.json 用路由 mock 固定数据,避免真实文件超出 7 天窗口后场景失效。

// 与 src/lib/changelogDate.ts 的 toChangelogDay 同语义:时间轴左移 8h 后取本地日历日。
const toChangelogDay = (ts) => {
  const shifted = new Date(ts - 8 * 3_600_000)
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const day = String(shifted.getDate()).padStart(2, '0')
  return `${shifted.getFullYear()}-${month}-${day}`
}

const addChangelogDays = (day, offset) => {
  const [year, month, date] = day.split('-').map(Number)
  const next = new Date(year, month - 1, date + offset)
  const nextMonth = String(next.getMonth() + 1).padStart(2, '0')
  const nextDate = String(next.getDate()).padStart(2, '0')
  return `${next.getFullYear()}-${nextMonth}-${nextDate}`
}

const toShortDate = (day) => {
  const [, month, date] = day.split('-')
  return `${Number(month)}-${date}`
}

import { waitForCanvasReady } from '../renderer-evidence.mjs'

export const runChangelogScenario = async (context) => {
  const { baseUrl, canvasUrl, page, rendererMode } = context

  const today = toChangelogDay(Date.now())
  const olderDay = addChangelogDays(today, -1)
  const scrollItems = Array.from({ length: 28 }, (_, index) => ({
    text: `e2e-changelog 可滚动条目 ${index + 1}`,
    by: index % 2 === 0 ? 'E2E Author' : 'E2E Reviewer',
  }))
  const fixture = {
    lastGithash: 'e2e-fixture',
    updatedAt: '2099-01-01T12:00:00+08:00',
    entries: [
      {
        date: today,
        prs: [9001],
        // 新 schema {text, by} + 一条旧版纯 string(向后兼容:归入无名分组)
        features: [
          { text: 'e2e-changelog 新功能条目', by: 'E2E Author' },
          'e2e-changelog 旧格式条目',
          { text: 'e2e-changelog 审查者条目', by: 'E2E Reviewer' },
          ...scrollItems,
        ],
        fixes: [{ text: 'e2e-changelog 修复条目', by: 'E2E Fixer' }],
      },
      {
        date: olderDay,
        prs: [9000],
        features: [{ text: 'e2e-changelog 更早功能条目', by: 'E2E Earlier' }],
        fixes: [{ text: 'e2e-changelog 更早修复条目', by: 'E2E Earlier' }],
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
  await waitForCanvasReady(page, rendererMode)

  // ① 入口唯一且位于 Debug Log 正上方
  const changelogButton = page.getByRole('button', { name: 'Change Log', exact: true })
  if ((await changelogButton.count()) !== 1) {
    throw new Error('Project sidebar should expose one Change Log button')
  }
  const placement = await page.evaluate(() => {
    const changelog = document.querySelector('[aria-label="Change Log"]')?.getBoundingClientRect()
    const debugLog = document.querySelector('[aria-label="Debug Log"]')?.getBoundingClientRect()
    return { changelogBottom: changelog?.bottom, debugLogTop: debugLog?.top }
  })
  if (
    typeof placement.changelogBottom !== 'number' ||
    typeof placement.debugLogTop !== 'number' ||
    placement.changelogBottom > placement.debugLogTop
  ) {
    throw new Error(`Change Log entry should sit directly above Debug Log: ${JSON.stringify(placement)}`)
  }

  // ② 未读红点:localStorage 清空 + fixture updatedAt → 必有未读
  await page.waitForSelector('[aria-label="Change Log"] .changelog-badge-dot')

  // ③ 打开面板:默认最新一天 + 双列布局
  await changelogButton.click()
  await page.getByRole('dialog', { name: '更新日志' }).waitFor()
  await page.locator('.changelog-day-date').waitFor()
  const initialDate = await page.locator('.changelog-day-date').textContent()
  if (initialDate !== today) {
    throw new Error(`Changelog carousel should default to the latest day: ${initialDate}`)
  }
  const dateBarText = (await page.locator('.changelog-date-bar').textContent())?.trim()
  if (dateBarText !== toShortDate(today)) {
    throw new Error(`Changelog date bar should show only the centered date (no 1/N): ${dateBarText}`)
  }
  // 等卡片入场动画(changelog-day-in 150ms 带位移)播完再量布局,否则中点会测在动画半途。
  await page.waitForFunction(() => {
    const day = document.querySelector('.changelog-day')
    return day instanceof HTMLElement && day.getAnimations().length === 0
  })
  const navLayout = await page.evaluate(() => {
    const card = document.querySelector('.changelog-day')?.getBoundingClientRect()
    const dots = document.querySelector('.changelog-dots')?.getBoundingClientRect()
    const arrows = Array.from(document.querySelectorAll('.changelog-carousel-arrow')).map((el) =>
      el.getBoundingClientRect(),
    )
    if (!card || !dots || arrows.length !== 2) return null
    return {
      dotsGap: dots.top - card.bottom,
      dotsCenterDelta: Math.abs((dots.left + dots.right) / 2 - (card.left + card.right) / 2),
      leftArrowFlanks: arrows[0].right <= card.left,
      rightArrowFlanks: arrows[1].left >= card.right,
    }
  })
  if (
    !navLayout ||
    navLayout.dotsGap < 10 ||
    navLayout.dotsGap > 14 ||
    navLayout.dotsCenterDelta > 2 ||
    !navLayout.leftArrowFlanks ||
    !navLayout.rightArrowFlanks
  ) {
    throw new Error(
      `Changelog nav should be arrows flanking the card with centered dots ~12px below: ${JSON.stringify(navLayout)}`,
    )
  }
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

  // ③ 续:作者分组为独占粗体行,无 @ 标签;旧 string 条目进入无名末尾分组
  const authorGroups = await page.evaluate(() => {
    const names = Array.from(document.querySelectorAll('.changelog-author-name')).map((name) => ({
      text: name.textContent ?? '',
      weight: Number.parseInt(window.getComputedStyle(name).fontWeight, 10),
    }))
    const featureGroupOrder = Array.from(
      document.querySelectorAll('.changelog-day-columns .changelog-column:first-child .changelog-author-group'),
    ).map((group) => group.querySelector('.changelog-author-name')?.textContent ?? '')
    const anonymousGroups = Array.from(document.querySelectorAll('.changelog-author-group.anonymous')).map((group) => ({
      text: group.textContent ?? '',
      hasName: Boolean(group.querySelector('.changelog-author-name')),
    }))
    return {
      names,
      featureGroupOrder,
      anonymousGroups,
      byTagCount: document.querySelectorAll('.changelog-item-by').length,
    }
  })
  const requiredAuthors = ['E2E Author', 'E2E Reviewer', 'E2E Fixer']
  const hasRequiredAuthors = requiredAuthors.every((author) =>
    authorGroups.names.some((name) => name.text === author && name.weight >= 600),
  )
  const hasAnonymousLegacy = authorGroups.anonymousGroups.some(
    (group) => group.text.includes('旧格式条目') && !group.hasName,
  )
  const featureGroupsInExpectedOrder =
    authorGroups.featureGroupOrder[0] === 'E2E Author' &&
    authorGroups.featureGroupOrder[1] === 'E2E Reviewer' &&
    authorGroups.featureGroupOrder.at(-1) === ''
  if (
    !hasRequiredAuthors ||
    !hasAnonymousLegacy ||
    !featureGroupsInExpectedOrder ||
    authorGroups.byTagCount !== 0
  ) {
    throw new Error(`Changelog should render maker-style author groups: ${JSON.stringify(authorGroups)}`)
  }

  // ③ 续:单日卡片内部可滚动
  const scrollProbe = await page.evaluate(() => {
    const scroller = document.querySelector('.changelog-day-scroll')
    if (!(scroller instanceof HTMLElement)) return null
    const before = scroller.scrollTop
    scroller.scrollTop = scroller.scrollHeight
    return {
      before,
      after: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    }
  })
  if (!scrollProbe || scrollProbe.scrollHeight <= scrollProbe.clientHeight || scrollProbe.after <= scrollProbe.before) {
    throw new Error(`Changelog day card should keep an internal scroll area: ${JSON.stringify(scrollProbe)}`)
  }

  // ⑤ 轮播:右箭头 icon 切到更早日期,键盘左箭头切回最新(轨道语义:最左=最新)
  await page.getByRole('button', { name: '切换到更早更新日志' }).click()
  await page.waitForFunction((expected) => document.querySelector('.changelog-day-date')?.textContent === expected, olderDay)
  await page.getByText('e2e-changelog 更早功能条目').waitFor()
  const olderButtonDisabled = await page.getByRole('button', { name: '切换到更早更新日志' }).isDisabled()
  if (!olderButtonDisabled) {
    throw new Error('Changelog carousel should disable the earlier button at the oldest day')
  }
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction((expected) => document.querySelector('.changelog-day-date')?.textContent === expected, today)
  const newerButtonDisabled = await page.getByRole('button', { name: '切换到更新的更新日志' }).isDisabled()
  if (!newerButtonDisabled) {
    throw new Error('Changelog carousel should disable the newer button at the latest day')
  }

  // ② 续:打开即已读,红点消失
  await page.waitForSelector('[aria-label="Change Log"] .changelog-badge-dot', { state: 'detached' })

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
  if (await page.locator('[aria-label="Change Log"] .changelog-badge-dot').count()) {
    throw new Error('Changelog badge dot should stay cleared after reading')
  }

  // 已读状态跨 reload 保持:updatedAt 不变时红点不重亮
  await page.reload({ waitUntil: 'networkidle' })
  await waitForCanvasReady(page, rendererMode)
  await page.getByRole('button', { name: 'Change Log', exact: true }).waitFor()
  if (await page.locator('[aria-label="Change Log"] .changelog-badge-dot').count()) {
    throw new Error('Changelog badge dot should stay cleared across reload when updatedAt is unchanged')
  }

  // 同日追加场景:仅 updatedAt 变化(entries 同日追加)→ 红点重新点亮
  fixture.updatedAt = '2099-02-02T12:00:00+08:00'
  fixture.entries[0].fixes = [...fixture.entries[0].fixes, 'e2e-changelog 同日追加的修复条目']
  await page.reload({ waitUntil: 'networkidle' })
  await waitForCanvasReady(page, rendererMode)
  await page.waitForSelector('[aria-label="Change Log"] .changelog-badge-dot')

  await page.unroute('**/changelog.json*')
}
