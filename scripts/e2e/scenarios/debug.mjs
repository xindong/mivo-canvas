export const runDebugScenario = async (context) => {
  const { baseUrl, page } = context

  const remoteDebugResponse = await page.request.post(`${baseUrl}/api/mivo/debug-logs`, {
    data: {
      clientId: 'e2e-client',
      sessionId: 'e2e-session',
      appVersion: 'e2e',
      pagePath: '/canvas',
      userAgent: 'E2E Browser',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
      screen: { width: 1512, height: 900, pixelRatio: 1 },
      entries: [
        { level: 'log', source: 'E2E', message: 'not uploaded', timestamp: Date.now() },
        { level: 'warning', source: 'E2E Warning', message: 'e2e-remote warning', timestamp: Date.now() },
        { level: 'error', source: 'E2E Error', message: 'e2e-remote error token=SHOULD_HIDE', timestamp: Date.now() },
        ...Array.from({ length: 32 }, (_, index) => ({
          level: 'error',
          source: 'E2E Overflow',
          message: `e2e-remote overflow ${index + 1}`,
          timestamp: Date.now() + index,
        })),
      ],
    },
  })
  const remoteDebugPost = await remoteDebugResponse.json()
  if (!remoteDebugResponse.ok() || remoteDebugPost.accepted !== 34) {
    throw new Error(`Remote debug POST should accept warning/error only: ${JSON.stringify(remoteDebugPost)}`)
  }
  const remoteDebugQueryResponse = await page.request.get(`${baseUrl}/api/mivo/debug-logs?level=error&q=e2e-remote%20error`)
  const remoteDebugQuery = await remoteDebugQueryResponse.json()
  if (
    !remoteDebugQueryResponse.ok() ||
    remoteDebugQuery.records?.length !== 1 ||
    remoteDebugQuery.records[0].clientId !== 'e2e-client' ||
    !remoteDebugQuery.records[0].message.includes('token=[redacted]')
  ) {
    throw new Error(`Remote debug GET should return sanitized filtered records: ${JSON.stringify(remoteDebugQuery)}`)
  }
  await page.goto(`${baseUrl}/#/debug-reports`, { waitUntil: 'networkidle' })
  if ((await page.getByRole('heading', { name: 'Remote Debug Reports' }).count()) !== 1) {
    throw new Error('Debug reports browser should render at /debug-reports')
  }
  await page.getByText('e2e-remote error', { exact: false }).waitFor()
  if ((await page.getByText('e2e-remote error', { exact: false }).count()) !== 1) {
    throw new Error('Debug reports browser should show uploaded remote error records')
  }
  if ((await page.locator('.debug-reports-table-heading').count()) !== 1) {
    throw new Error('Debug reports browser should use a table-style heading for scannable records')
  }
  const debugReportsLayout = await page.locator('.debug-reports-list').evaluate((list) => {
    const page = document.querySelector('.debug-reports-page')
    const toolbar = document.querySelector('.debug-reports-toolbar')
    const firstRecord = document.querySelector('.debug-reports-record')
    const firstGrid = document.querySelector('.debug-reports-record-grid')
    const listRect = list.getBoundingClientRect()
    const pageRect = page?.getBoundingClientRect()
    const toolbarRect = toolbar?.getBoundingClientRect()
    const recordRect = firstRecord?.getBoundingClientRect()
    const gridStyle = firstGrid ? window.getComputedStyle(firstGrid) : undefined

    return {
      listWidth: listRect.width,
      pageWidth: pageRect?.width || 0,
      toolbarWidth: toolbarRect?.width || 0,
      recordWidth: recordRect?.width || 0,
      gridColumns: gridStyle?.gridTemplateColumns || '',
    }
  })
  if (
    debugReportsLayout.listWidth < Math.min(1120, debugReportsLayout.pageWidth - 56) ||
    debugReportsLayout.recordWidth < debugReportsLayout.listWidth - 24 ||
    !debugReportsLayout.gridColumns.includes('px')
  ) {
    throw new Error(`Debug reports browser should use a wide stable log table layout: ${JSON.stringify(debugReportsLayout)}`)
  }
  const debugReportsCopyButtonStyle = await page.locator('.debug-reports-record-grid button').first().evaluate((button) => {
    const style = window.getComputedStyle(button)
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      color: style.color,
    }
  })
  if (
    debugReportsCopyButtonStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
    debugReportsCopyButtonStyle.borderColor !== 'rgba(0, 0, 0, 0)'
  ) {
    throw new Error(`Debug report copy button should not show a default gray button box: ${JSON.stringify(debugReportsCopyButtonStyle)}`)
  }
  const debugReportsListScroll = await page.locator('.debug-reports-list').evaluate((list) => {
    list.scrollTop = list.scrollHeight

    return {
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      scrollTop: list.scrollTop,
    }
  })
  if (
    debugReportsListScroll.scrollHeight <= debugReportsListScroll.clientHeight ||
    debugReportsListScroll.scrollTop <= 0
  ) {
    throw new Error(`Debug reports list should scroll internally: ${JSON.stringify(debugReportsListScroll)}`)
  }

}
