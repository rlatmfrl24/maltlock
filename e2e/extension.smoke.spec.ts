import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect, test, type BrowserContext } from '@playwright/test'

function resolveExtensionDistPath(): string {
  const currentFilePath = fileURLToPath(import.meta.url)
  const currentDir = path.dirname(currentFilePath)
  return path.resolve(currentDir, '..', 'dist')
}

async function launchExtensionContext(): Promise<BrowserContext> {
  const extensionPath = resolveExtensionDistPath()
  const userDataDir = path.join(extensionPath, '.playwright-user-data')

  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  })
}

async function getExtensionId(context: BrowserContext): Promise<string> {
  const existing = context.serviceWorkers()[0]
  const worker =
    existing ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }))

  return new URL(worker.url()).host
}

test('sidepanel smoke check', async () => {
  const context = await launchExtensionContext()

  try {
    const extensionId = await getExtensionId(context)
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`)

    await expect(page.getByRole('heading', { name: 'Maltlock Crawler' })).toBeVisible()
    await expect(page.getByRole('button', { name: '크롤' })).toBeVisible()
    await expect(page.getByText('선택 사이트: KissJAV')).toBeVisible()
    await expect(page.getByRole('button', { name: /사생활 모드/ })).toBeVisible()
  } finally {
    await context.close()
  }
})

