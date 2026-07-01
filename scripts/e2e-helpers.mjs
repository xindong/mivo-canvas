export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const waitForServer = async (baseUrl) => {
  const started = Date.now()

  while (Date.now() - started < 20000) {
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {
      await wait(250)
    }
  }

  throw new Error(`Dev server did not start at ${baseUrl}`)
}

export const rectsOverlap = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

export const nearlyEqual = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance

export const createPageReaders = (page) => {
  const readFloatingChrome = async () =>
    page.evaluate(() => {
      const chrome = document.querySelector('.project-floating-chrome')
      const navigation = chrome?.querySelector('.top-navigation')
      const logo = chrome?.querySelector('.floating-sidebar-mark .mivo-logo')?.getBoundingClientRect()
      const openButton = chrome?.querySelector('[aria-label="Open projects"]')?.getBoundingClientRect()

      return {
        chromeCount: document.querySelectorAll('.project-floating-chrome').length,
        navigationCount: document.querySelectorAll('.project-floating-chrome .top-navigation').length,
        chromePosition: chrome ? window.getComputedStyle(chrome).position : undefined,
        navigationExists: Boolean(navigation),
        logo: logo
          ? {
              left: logo.left,
              top: logo.top,
              width: logo.width,
              height: logo.height,
            }
          : undefined,
        openButton: openButton
          ? {
              left: openButton.left,
              top: openButton.top,
              width: openButton.width,
              height: openButton.height,
            }
          : undefined,
      }
    })

  const readLibraryLayout = async () =>
    page.evaluate(() => {
      const workspace = document.querySelector('.workspace.library-mode, .workspace')?.getBoundingClientRect()
      const library = document.querySelector('.library-workspace')?.getBoundingClientRect()
      const title = document.querySelector('.library-workspace h1')?.getBoundingClientRect()

      return {
        viewportWidth: window.innerWidth,
        workspace: workspace
          ? {
              left: workspace.left,
              width: workspace.width,
            }
          : undefined,
        library: library
          ? {
              left: library.left,
              width: library.width,
            }
          : undefined,
        title: title
          ? {
              left: title.left,
              top: title.top,
            }
          : undefined,
      }
    })

  const readLibrarySurfaceColors = async () =>
    page.evaluate(() => {
      const app = document.querySelector('.mivo-app')
      const workspace = document.querySelector('.workspace.library-mode')
      const library = document.querySelector('.library-workspace')
      const leftProbe = document.elementFromPoint(120, 420)
      const rightProbe = document.elementFromPoint(260, 420)

      return {
        appBackground: app ? window.getComputedStyle(app).backgroundColor : undefined,
        workspaceBackground: workspace ? window.getComputedStyle(workspace).backgroundColor : undefined,
        libraryBackground: library ? window.getComputedStyle(library).backgroundColor : undefined,
        leftProbeBackground: leftProbe ? window.getComputedStyle(leftProbe).backgroundColor : undefined,
        rightProbeBackground: rightProbe ? window.getComputedStyle(rightProbe).backgroundColor : undefined,
        hasLibraryActiveClass: app?.classList.contains('library-active'),
      }
    })

  return {
    readFloatingChrome,
    readLibraryLayout,
    readLibrarySurfaceColors,
  }
}

export const assertLibraryLayoutStable = (label, before, after) => {
  if (
    !before.workspace ||
    !before.library ||
    !before.title ||
    !after.workspace ||
    !after.library ||
    !after.title ||
    !nearlyEqual(before.workspace.left, 240, 2) ||
    !nearlyEqual(after.workspace.left, before.workspace.left) ||
    !nearlyEqual(after.workspace.width, before.workspace.width) ||
    !nearlyEqual(after.workspace.width, after.viewportWidth - 240, 2) ||
    !nearlyEqual(after.library.left, before.library.left) ||
    !nearlyEqual(after.title.left, before.title.left) ||
    !nearlyEqual(after.title.top, before.title.top)
  ) {
    throw new Error(
      `${label} workspace should stay fixed when the project sidebar collapses: before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`,
    )
  }
}
