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

async function resetExtensionData(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.clear()
    await Promise.all((await caches.keys()).map((name) => caches.delete(name)))

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('maltlock-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const storeNames = Array.from(database.objectStoreNames)
    if (storeNames.length > 0) {
      const transaction = database.transaction(storeNames, 'readwrite')
      for (const storeName of storeNames) transaction.objectStore(storeName).clear()
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
    }
    database.close()
  })
}

async function seedThumbnailItem(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('maltlock-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('items', 'readwrite')
    transaction.objectStore('items').put({
      id: 'thumbnail-reconnect-item',
      siteId: 'kissjav-most-popular-week',
      title: 'Thumbnail reconnect smoke item',
      url: 'https://kissjav.com/video/thumbnail-smoke',
      previewImageUrl: 'https://images.test/thumbnail.png',
      crawledAt: Date.now(),
    })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  })
}

test('sidepanel smoke check', async () => {
  const context = await launchExtensionContext()

  try {
    const extensionId = await getExtensionId(context)
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`)

    await expect(page.getByRole('heading', { name: 'Maltlock Crawler' })).toBeVisible()
    await expect(page.getByRole('button', { name: '크롤' })).toBeVisible()
    await expect(page.getByRole('button', { name: /KissJAV/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('button', { name: /사생활 모드/ })).toBeVisible()
    await page.getByText('실행 진단').click()
    await expect(
      page.getByRole('checkbox', { name: '파서 실패 원본 로컬 보관' }),
    ).not.toBeChecked()
  } finally {
    await context.close()
  }
})

test('restores a cached thumbnail after reopening the sidepanel', async () => {
  const context = await launchExtensionContext()
  let serveRemoteThumbnail = true
  await context.route('https://images.test/thumbnail.png', async (route) => {
    if (!serveRemoteThumbnail) {
      await route.abort('failed')
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    })
  })

  try {
    const extensionId = await getExtensionId(context)
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`)
    await resetExtensionData(page)
    await seedThumbnailItem(page)
    await page.reload()

    const thumbnail = page.getByAltText('Thumbnail reconnect smoke item')
    await expect(thumbnail).toBeVisible()
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await caches.open('maltlock-thumbnails-v1')).keys().then((keys) => keys.length),
        ),
      )
      .toBe(1)

    serveRemoteThumbnail = false
    await page.reload()

    const restoredThumbnail = page.getByAltText('Thumbnail reconnect smoke item')
    await expect(restoredThumbnail).toBeVisible()
    await expect
      .poll(() => restoredThumbnail.getAttribute('src'))
      .toMatch(/^blob:chrome-extension:\/\//)
    await expect
      .poll(() =>
        restoredThumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1)
  } finally {
    await context.close()
  }
})
