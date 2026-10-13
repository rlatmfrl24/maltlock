import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, expect, test, type BrowserContext } from '@playwright/test'
import type { CrawledItem } from '../src/types/contracts'
import { nimiTwRankingParser } from '../src/parsers/nimi-tw-ranking.parser'

type ReviewSnapshotGate = typeof globalThis & { snapshotWaiting?: boolean; releaseSnapshot?: () => void }

function resolveExtensionDistPath(): string {
  const currentFilePath = fileURLToPath(import.meta.url)
  const currentDir = path.dirname(currentFilePath)
  return path.resolve(currentDir, '..', 'dist')
}

test('library selection stays local in both views', async () => {
  const context = await launchExtensionContext()
  await context.route('https://other.test/**', (route) => route.fulfill({ body: '<h1>Keep browsing</h1>' }))
  try {
    const id = await getExtensionId(context)
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${id}/sidepanel.html`)
    await resetExtensionData(panel)
    const site = await context.newPage()
    await site.goto('https://other.test/keep')
    await site.bringToFront()
    await expect(panel.getByRole('tab', { name: '수집결과', exact: true })).toHaveAttribute('aria-selected', 'true')
    await panel.getByRole('button', { name: /^NimiWiki\b/ }).click()
    await expect(site).toHaveURL('https://other.test/keep')
    await expect(panel.locator('#step-list')).toBeVisible()
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByRole('button', { name: /^Kone\b/ }).click()
    await expect(site).toHaveURL('https://other.test/keep')
    await expect(panel.locator('#step-crawl')).toBeVisible()
    await panel.getByRole('tab', { name: '크롤링', exact: true }).focus()
    await panel.keyboard.press('ArrowLeft')
    await expect(panel.getByRole('tab', { name: '수집결과', exact: true })).toBeFocused()
    await expect(panel.locator('#step-list')).toBeVisible()
  } finally { await context.close() }
})

test('one click moves to the configured site, saves items and returns to results', async () => {
  const context = await launchExtensionContext()
  const listing = readFileSync(path.resolve('src/test/fixtures/parsers/kone_new.html'), 'utf8')
  await context.route('https://kone.gg/**', (route) => route.fulfill({ contentType: 'text/html', body: listing }))
  try {
    const id = await getExtensionId(context)
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${id}/sidepanel.html`)
    await resetExtensionData(panel)
    const site = await context.newPage()
    await site.bringToFront()
    await panel.getByRole('button', { name: /^Kone\b/ }).click()
    expect(site.url()).toBe('about:blank')
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByRole('button', { name: '크롤링 시작', exact: true }).click()
    await expect(site).toHaveURL('https://kone.gg/s/pornvideo?mode=hot')
    await expect(panel.locator('#step-list')).toBeVisible()
    const saved = await readSavedItems(panel)
    expect(saved.length).toBeGreaterThan(0)
    expect(saved.every((item) => item.siteId === 'kone-pornvideo-hot')).toBe(true)
    await expect(panel.locator('.item-row')).toHaveCount(saved.length)
    await expect(panel.getByRole('status')).toContainText(`신규 ${saved.length}건`)
  } finally { await context.close() }
})

async function launchExtensionContext(): Promise<BrowserContext> {
  const extensionPath = resolveExtensionDistPath()
  return chromium.launchPersistentContext('', {
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

for (const target of [
  { name: 'Kone', url: 'https://kone.gg/s/pornvideo?mode=hot' },
  { name: '123AV', url: 'https://123av.com/ko/all?sort=week' },
  { name: 'TwiDouga', url: 'https://www.twidouga.net/ko/ranking_t1.php' },
  { name: 'NimiWiki', url: 'https://video1.nimi.wiki/tw/ranking?sort=plays&period=week' },
]) {
  test(`${target.name} preserves manual navigation while its pre-navigation snapshot is pending`, async () => {
    const context = await launchExtensionContext()
    await context.route(/^https:\/\//, (route) => route.fulfill({ contentType: 'text/html', body: '<html><body>Navigation review</body></html>' }))
    try {
      const id = await getExtensionId(context)
      const panel = await context.newPage()
      await panel.goto(`chrome-extension://${id}/sidepanel.html`)
      await resetExtensionData(panel)
      const site = await context.newPage()
      await site.bringToFront()
      await panel.getByRole('button', { name: new RegExp(`^${target.name}\\b`) }).click()
      await site.goto(target.url)
      await site.waitForLoadState('load')
      if (target.name === 'TwiDouga') {
        await site.goto('https://www.twidouga.net/ko/ranking_t2.php')
        await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
        await panel.locator('#twidouga-crawl-mode').selectOption('all')
      } else if (target.name === 'NimiWiki') {
        await site.goto('https://video1.nimi.wiki/ig/new')
        await expect(panel.getByLabel('NimiWiki 수집 범위')).toHaveValue('all')
      } else {
        await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
        await panel.locator('#range-crawl-mode').selectOption('all')
        await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
        await panel.getByLabel('시작 페이지').fill('2')
        await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
        await panel.getByLabel('끝 페이지').fill('2')
      }
      await panel.evaluate(() => {
        const execute = chrome.scripting.executeScript.bind(chrome.scripting)
        const world = globalThis as ReviewSnapshotGate
        let held = false
        chrome.scripting.executeScript = async (injection) => {
          if (!held) {
            held = true
            const result = await execute(injection)
            world.snapshotWaiting = true
            await new Promise<void>((resolve) => { world.releaseSnapshot = resolve })
            return result
          }
          return execute(injection)
        }
      })
      const start = panel.getByRole('button', { name: '크롤링 시작', exact: true })
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await start.click()
      await panel.waitForFunction(() => (globalThis as ReviewSnapshotGate).snapshotWaiting)
      await site.goto('https://other.test/manual-navigation')
      await panel.evaluate(() => (globalThis as ReviewSnapshotGate).releaseSnapshot?.())
      await expect(panel.locator('#step-list')).toBeVisible({ timeout: 5_000 })
      await expect(site).toHaveURL('https://other.test/manual-navigation')
      await expect(panel.getByRole('status')).toContainText('다른 페이지로 이동')
      expect(await readSavedItems(panel)).toEqual([])
    } finally { await context.close() }
  })
}

for (const mode of ['stop', 'timeout']) {
  test(`TwiDouga ${mode} settles while the site's main thread blocks its snapshot`, async () => {
    const context = await launchExtensionContext()
    let busy = false
    await context.route('https://www.twidouga.net/**', (route) => route.fulfill({ contentType: 'text/html', body:
      `<html><body>Loading ranking${busy ? '<script>setTimeout(() => { const end = Date.now() + 21000; while (Date.now() < end) {} }, 250)</script>' : ''}</body></html>`,
    }))
    try {
      const id = await getExtensionId(context)
      const panel = await context.newPage()
      await panel.goto(`chrome-extension://${id}/sidepanel.html`)
      await resetExtensionData(panel)
      const site = await context.newPage()
      await site.bringToFront()
      await panel.getByRole('button', { name: /^TwiDouga\b/ }).click()
      await site.goto('https://www.twidouga.net/ko/ranking_t1.php')
      await site.waitForLoadState('load')
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await panel.locator('#twidouga-crawl-mode').selectOption('all')
      busy = true
      const navigation = context.waitForEvent('request', { predicate: (request) => request.url().endsWith('/ko/ranking_t1.php') })
      const start = panel.getByRole('button', { name: '크롤링 시작', exact: true })
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await start.click()
      await navigation
      if (mode === 'stop') {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        await panel.getByRole('button', { name: '수집 중지', exact: true }).click()
      }
      await expect(panel.locator('#step-list')).toBeVisible({ timeout: mode === 'stop' ? 2_000 : 18_000 })
      await expect(panel.getByRole('status')).toContainText(mode === 'stop' ? '수집 중지' : '문서 응답 시간이 초과')
      expect(await readSavedItems(panel)).toEqual([])
    } finally { await context.close() }
  })
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

async function readSavedItems(page: import('@playwright/test').Page): Promise<CrawledItem[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('maltlock-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const items = await new Promise<CrawledItem[]>((resolve, reject) => {
      const request = db.transaction('items').objectStore('items').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return items
  })
}

test('saved lists show every legacy group member as an individual row with source filtering and deletion', async () => {
  const context = await launchExtensionContext()
  try {
    const id = await getExtensionId(context)
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${id}/sidepanel.html`)
    await resetExtensionData(panel)
    await panel.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('maltlock-db'); r.onsuccess = () => resolve(r.result) })
      const tx = db.transaction('items', 'readwrite')
      const rows: CrawledItem[] = [
        { id: 'legacy-tw-first', siteId: 'nimi-tw-ranking', sourcePlatform: 'tw', title: 'Legacy Twitter first', url: 'https://video.twimg.com/amplify_video/91001/vid/a.mp4', crawledAt: 1 },
        { id: 'legacy-tw-second', siteId: 'nimi-tw-ranking', sourcePlatform: 'tw', title: 'Legacy Twitter second', url: 'https://video.twimg.com/amplify_video/91002/vid/b.mp4', crawledAt: 2 },
        { id: 'legacy-ig', siteId: 'nimi-tw-ranking', sourcePlatform: 'ig', title: 'Legacy Instagram', url: 'https://cdninstagram.com/video.mp4', crawledAt: 3 },
        { id: 'legacy-other-site', siteId: 'kone-pornvideo-hot', title: 'Other site member', url: 'https://kone.gg/s/pornvideo/91003', crawledAt: 4 },
      ]
      for (const row of rows) tx.objectStore('items').put({ ...row, contentGroupId: 'old-shared-group', groupReason: 'title-similar', groupScore: .99 })
      await new Promise<void>((resolve) => { tx.oncomplete = () => resolve() })
      db.close()
    })
    await panel.reload()
    await panel.getByRole('tab', { name: '수집결과', exact: true }).click()
    await panel.getByRole('button', { name: /^NimiWiki\b/ }).click()
    await expect(panel.locator('.item-row')).toHaveCount(3)
    await expect(panel.locator('#step-list .section-heading')).toContainText('3건')
    await expect(panel.locator('.group-toggle, .group-members, .separate-button')).toHaveCount(0)
    await expect(panel.locator('.source-platform')).toHaveCount(3)
    await expect(panel.locator('.list-footer')).toContainText('전체 저장: 4건')
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('tw')
    await expect(panel.locator('.item-row')).toHaveCount(2)
    await panel.getByRole('button', { name: '현재 출처 전체 선택', exact: true }).click()
    await expect(panel.locator('.item-select:checked')).toHaveCount(2)
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('ig')
    await expect(panel.locator('.item-row')).toHaveCount(1)
    await expect(panel.locator('.bulk-actions')).toContainText('선택 2건')
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('tw')
    await panel.getByRole('button', { name: 'Legacy Twitter first 삭제', exact: true }).click()
    await expect(panel.locator('.item-row')).toHaveCount(1)
    await expect(panel.locator('.bulk-actions')).toContainText('선택 1건')
    expect((await readSavedItems(panel)).map((item) => item.id).sort()).toEqual(['legacy-ig', 'legacy-other-site', 'legacy-tw-second'])
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('')
    await expect(panel.locator('.item-row')).toHaveCount(2)
    await panel.setViewportSize({ width: 320, height: 480 })
    expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    const lastItem = panel.getByRole('link', { name: 'Legacy Twitter second', exact: true })
    await lastItem.scrollIntoViewIfNeeded()
    await expect(lastItem).toBeInViewport()
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('tw')
    await panel.getByRole('button', { name: 'Legacy Twitter second 삭제', exact: true }).focus()
    await panel.keyboard.press('Enter')
    await expect(panel.getByRole('heading', { name: '수집결과', exact: true })).toBeFocused()
    await expect(panel.locator('.item-row')).toHaveCount(0)
    expect((await readSavedItems(panel)).map((item) => item.id).sort()).toEqual(['legacy-ig', 'legacy-other-site'])
  } finally { await context.close() }
})

test('NimiWiki cycles weekly platforms, persists sources, filters before the limit, and handles failures', async () => {
  test.setTimeout(120_000)
  const context = await launchExtensionContext()
  const origin = 'https://video1.nimi.wiki'
  const platforms = ['tw', 'ig', 'tt', 'bs']
  const labels = ['트위터', '인스타그램', '틱톡', '블루스카이']
  const payloads = JSON.parse(readFileSync(new URL('../src/test/fixtures/parsers/nimi_platform_api.json', import.meta.url), 'utf-8'))
  const cachedTwitter = payloads.tw.items[0]
  const twitterHtml = `<div>1</div><a href="${cachedTwitter.posts[0].url}"><img src="${cachedTwitter.thumbnail_url}" alt="Cached Twitter" /></a><video src="${cachedTwitter.file_url}"></video>`
  expect(nimiTwRankingParser(twitterHtml, `${origin}/tw/ranking`)).toHaveLength(1)
  const visits: string[] = []
  const requests: string[] = []
  let failed = ''
  let empty = ''
  let slow = ''
  await context.route(`${origin}/**`, (route) => {
    if (new URL(route.request().url()).pathname.startsWith('/watch/')) {
      return route.fulfill({ contentType: 'text/html', body: '<html><body><video controls></video></body></html>' })
    }
    const platform = new URL(route.request().url()).pathname.split('/')[1]
    visits.push(platform)
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <div class="video-page" data-platform="${platform}"><h1>${platform} ranking</h1>${platform === 'tw' ? twitterHtml : ''}</div>
    </body></html>` })
  })
  await context.route('https://api.nimi.wiki/video/**', async (route) => {
    const url = new URL(route.request().url())
    const platform = url.pathname.split('/')[2]
    requests.push(url.pathname + url.search)
    if (platform === slow) await new Promise((resolve) => setTimeout(resolve, 16_000))
    await route.fulfill({ status: platform === failed ? 503 : 200, contentType: 'application/json',
      body: platform === failed ? '{"error":"unavailable"}' : JSON.stringify(platform === empty ? { items: [] } : payloads[platform]),
    }).catch(() => {}) // The timeout case aborts its request before this response.
  })
  await context.route('https://other.test/**', (route) => route.fulfill({ body: '<h1>Other tab</h1>' }))
  try {
    const id = await getExtensionId(context)
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${id}/sidepanel.html`)
    await resetExtensionData(panel)
    const site = await context.newPage()
    await site.goto(`${origin}/tw/new`)
    await site.bringToFront()
    await panel.getByRole('button', { name: 'NimiWiki', exact: false }).click()
    await expect(panel.getByLabel('NimiWiki 수집 범위')).toHaveValue('all')
    const start = panel.getByRole('button', { name: '크롤링 시작', exact: true })
    const status = panel.getByRole('status').first()
    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(status).toContainText('4개 플랫폼 주간 수집 완료 · 4/4개 플랫폼 처리 · 신규 8건 저장', { timeout: 30_000 })
    expect(visits).toEqual(platforms)
    expect(requests).toEqual(platforms.map((p) => `/video/${p}/ranking?sort=plays&period=week`))
    const saved = await readSavedItems(panel)
    expect(saved).toHaveLength(8)
    for (const platform of platforms) {
      const items = saved.filter((item) => item.sourcePlatform === platform)
      expect(items).toHaveLength(2)
      expect(items.every((item) => item.summary && new URL(item.url).hostname !== 'video1.nimi.wiki')).toBe(true)
    }
    await expect(panel.locator('#step-list')).toBeVisible()
    for (const [index, platform] of platforms.entries()) {
      await panel.getByLabel('NimiWiki 출처 필터').selectOption(platform)
      await expect(panel.locator('.source-platform')).toHaveCount(2)
      await expect(panel.locator('.source-platform').first()).toHaveText(`NimiWiki · ${labels[index]}`)
      await expect(panel.locator('#step-list .section-heading')).toContainText('2건')
    }
    const firstBlueskyRow = panel.locator('.item-row').first()
    const firstBlueskyId = await firstBlueskyRow.locator('.item-delete').getAttribute('data-item-id')
    const firstBluesky = saved.find((item) => item.id === firstBlueskyId)!
    const viewerUrl = `${origin}/watch/${firstBluesky.dedupeKey!.slice('nimi:bs:item:'.length)}`
    const preview = firstBlueskyRow.getByRole('link', { name: /영상 미리보기$/ })
    await expect(preview).toHaveAttribute('href', viewerUrl)
    await expect(firstBlueskyRow.locator('.item-title')).toHaveAttribute('href', firstBluesky.summary!)
    const downloads: string[] = []
    site.on('download', (download) => downloads.push(download.suggestedFilename()))
    await preview.click()
    await expect(site).toHaveURL(viewerUrl)
    await expect(site.locator('video')).toHaveAttribute('controls', '')
    const newPage = context.waitForEvent('page')
    await preview.click({ button: 'middle' })
    const newViewer = await newPage
    await expect(newViewer).toHaveURL(viewerUrl)
    await newViewer.close()
    expect(downloads).toEqual([])
    expect((await readSavedItems(panel)).find((item) => item.id === firstBlueskyId)?.url).toBe(firstBluesky.url)
    await site.goto(`${origin}/bs/ranking?sort=plays&period=week`)
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('ig')
    await panel.getByRole('button', { name: '현재 출처 전체 선택', exact: true }).click()
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('tt')
    await expect(panel.locator('.bulk-actions')).toContainText('선택 2건')
    await expect(panel.locator('.item-select:checked')).toHaveCount(0)
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('ig')
    await expect(panel.locator('.item-select:checked')).toHaveCount(2)
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(status).toContainText('신규 0건 저장 · 정확 중복 8건', { timeout: 30_000 })
    await expect(panel.locator('#step-list')).toBeVisible()
    expect(visits).toEqual(platforms)
    expect(await readSavedItems(panel)).toHaveLength(8)

    // Empty is successful; an HTTP failure is recorded and later platforms still save.
    empty = 'ig'
    failed = 'tt'
    requests.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(panel.locator('#step-list')).toBeVisible({ timeout: 30_000 })
    await expect(status).toContainText('3/4개 플랫폼 처리')
    await expect(status).toContainText('틱톡: NimiWiki API 요청에 실패했습니다. (HTTP 503)')
    await expect(panel.locator('#step-list')).toBeVisible()
    expect(requests).toHaveLength(4)
    failed = 'tw' // A rendered Twitter list must not hide an API failure.
    requests.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(panel.locator('#step-list')).toBeVisible({ timeout: 30_000 })
    await expect(status).toContainText('트위터: NimiWiki API 요청에 실패했습니다. (HTTP 503)')
    expect(requests).toHaveLength(4)
    expect(await readSavedItems(panel)).toHaveLength(8)
    empty = ''; failed = ''; slow = 'ig'
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(panel.locator('#step-list')).toBeVisible({ timeout: 35_000 })
    await expect(status).toContainText('인스타그램: NimiWiki API가 15초 안에 응답하지 않았습니다.')
    slow = ''

    // Stop and manual navigation must retain saved items and must not open the next platform.
    const stoppedRequest = context.waitForEvent('request', { predicate: (r) => r.url().includes('/video/tw/ranking') })
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click(); await stoppedRequest
    await panel.getByRole('button', { name: '수집 중지', exact: true }).click()
    await expect(status).toContainText('수집 중지')
    await expect(panel.locator('#step-list')).toBeVisible()
    const movedRequest = context.waitForEvent('request', { predicate: (r) => r.url().includes('/video/tw/ranking') })
    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click(); await movedRequest
    await site.goto('https://other.test/')
    await expect(panel.locator('#step-list')).toBeVisible({ timeout: 10_000 })
    await expect(site).toHaveURL('https://other.test/')
    expect(visits).toEqual(['tw'])
    expect(await readSavedItems(panel)).toHaveLength(8)

    // Current-list mode uses that platform's actual sort and period.
    await site.goto(`${origin}/ig/ranking?sort=likes`)
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByLabel('NimiWiki 수집 범위').selectOption('current')
    await panel.locator('.site-settings > summary').click()
    await panel.getByLabel('NimiWiki URL 커스터마이즈').fill(`${origin}/ig/ranking?sort=likes`)
    requests.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(panel.locator('#step-list')).toBeVisible()
    expect(requests).toEqual(['/video/ig/ranking?sort=likes'])

    // A valid empty current list completes and also opens the saved list.
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    empty = 'ig'
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(status).toContainText('0건 파싱, 신규 0건 저장')
    await expect(panel.locator('#step-list')).toBeVisible()

    await panel.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('maltlock-db'); r.onsuccess = () => resolve(r.result) })
      const tx = db.transaction('items', 'readwrite')
      for (let index = 0; index < 205; index++) tx.objectStore('items').put({
        id: `recent-tw-${index}`, siteId: 'nimi-tw-ranking', title: `Recent Twitter ${index}`,
        url: `https://video.twimg.com/recent-${index}.mp4`, crawledAt: Date.now() + index,
      })
      await new Promise<void>((resolve) => { tx.oncomplete = () => resolve() })
      db.close()
    })
    await panel.reload() // Native IDB seeding does not notify Dexie's live queries.
    await panel.getByRole('tab', { name: '수집결과', exact: true }).click()
    await panel.getByRole('button', { name: /^NimiWiki\b/ }).click()
    await expect(panel.locator('.list-footer')).toContainText('200 / 213건 표시')
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('tw')
    await expect(panel.locator('#step-list .section-heading')).toContainText('207건')
    await panel.getByRole('button', { name: '현재 출처 전체 선택', exact: true }).click()
    await expect(panel.locator('.bulk-actions')).toContainText('선택 207건')
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('ig')
    await expect(panel.locator('.source-platform')).toHaveCount(2)
    await panel.setViewportSize({ width: 320, height: 480 })
    expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    const list = await panel.locator('.item-list').boundingBox()
    expect(list!.height).toBeGreaterThanOrEqual(100)
  } finally { await context.close() }
})

test('NimiWiki live weekly collection reaches all platforms and persists their API items', async ({ browserName }, testInfo) => {
  test.skip(process.env.MALTLOCK_LIVE_NIMI !== '1', 'Explicit live-source verification')
  test.setTimeout(120_000)
  const context = await launchExtensionContext()
  try {
    const id = await getExtensionId(context)
    const payloads = new Map<string, string>()
    const reads: Promise<void>[] = []
    context.on('response', (response) => {
      if (response.url().startsWith('https://api.nimi.wiki/video/') && response.request().serviceWorker()?.url().startsWith(`chrome-extension://${id}/`)) {
        reads.push(response.text().then((body) => { payloads.set(new URL(response.url()).pathname.split('/')[2], body) }))
      }
    })
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${id}/sidepanel.html`)
    await resetExtensionData(panel)
    const site = await context.newPage()
    await site.goto('about:blank')
    await site.bringToFront()
    await panel.getByRole('button', { name: 'NimiWiki', exact: false }).click()
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByRole('button', { name: '크롤링 시작', exact: true }).click()
    await expect(panel.getByRole('status').first()).toContainText('4개 플랫폼 주간 수집 완료 · 4/4개 플랫폼 처리', { timeout: 100_000 })
    await Promise.all(reads)
    const saved = await readSavedItems(panel)
    for (const platform of ['tw', 'ig', 'tt', 'bs']) {
      const rows = saved.filter((item) => item.sourcePlatform === platform)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((item) => item.summary && item.previewImageUrl && item.url)).toBe(true)
      expect(payloads.has(platform)).toBe(true)
      const expectedItems = nimiTwRankingParser(payloads.get(platform)!, `https://video1.nimi.wiki/${platform}/ranking?sort=plays&period=week`)
      const missing = expectedItems.filter((item) => !rows.some((row) => row.dedupeKey === item.dedupeKey || item.identities?.some((identity) =>
        row.identities?.some((stored) => stored.kind === identity.kind && stored.scope === identity.scope && stored.value === identity.value))))
      expect(missing).toHaveLength(0)
      console.log(`LIVE_NIMI ${platform}: parsed=${expectedItems.length}, saved=${rows.length}, missing=${missing.length}`)
    }
    await expect(panel.locator('#step-list')).toBeVisible()
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('bs')
    await expect(panel.locator('.source-platform').first()).toHaveText('NimiWiki · 블루스카이')
    await expect(site).toHaveURL('https://video1.nimi.wiki/bs/ranking?sort=plays&period=week')
    await panel.setViewportSize({ width: 400, height: 600 })
    await panel.bringToFront()
    await expect.poll(() => panel.locator('img.item-preview').first().evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0)
    await panel.screenshot({ path: testInfo.outputPath(`live-${browserName}-results-400x600.png`) })
    await site.bringToFront()
    const preview = panel.locator('.item-url').first()
    const previewUrl = await preview.getAttribute('href')
    expect(previewUrl).toMatch(/^https:\/\/video1\.nimi\.wiki\/watch\/[\w-]+$/)
    const downloads: string[] = []
    site.on('download', (download) => downloads.push(download.suggestedFilename()))
    await preview.click()
    await expect(site).toHaveURL(previewUrl!)
    await site.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1, null, { timeout: 25_000 })
    await site.locator('video').evaluate(async (video: HTMLVideoElement) => { video.muted = true; await video.play() })
    await site.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0, null, { timeout: 10_000 })
    expect(downloads).toEqual([])
    console.log('LIVE_NIMI Bluesky preview: web viewer opened, playback advanced, no download')
    const remove = panel.locator('.item-delete').first()
    const removedId = await remove.getAttribute('data-item-id')
    await panel.locator('.item-url').first().focus()
    await panel.keyboard.press('Tab')
    await expect(remove).toBeFocused()
    await panel.keyboard.press('Space')
    await expect(panel.locator('.item-delete').first()).toBeFocused()
    const afterDelete = await readSavedItems(panel)
    expect(afterDelete).toHaveLength(saved.length - 1)
    expect(afterDelete.some((item) => item.id === removedId)).toBe(false)
    expect(await panel.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('maltlock-db'); request.onsuccess = () => resolve(request.result) })
      const log = await new Promise((resolve) => { const request = db.transaction('crawledItemLogs').objectStore('crawledItemLogs').get(id!); request.onsuccess = () => resolve(request.result) })
      db.close()
      return !!log
    }, removedId)).toBe(true)
    console.log('LIVE_NIMI deletion: item removed, keyboard focus continued, seen log retained')
  } finally { await context.close() }
})

test('sidepanel smoke check', async () => {
  const context = await launchExtensionContext()

  try {
    const extensionId = await getExtensionId(context)
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`)

    await expect(page.getByRole('heading', { name: 'Maltlock', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: '수집결과', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: /KissJAV/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('button', { name: /ydkorea/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /사생활 모드/ })).toBeVisible()
    await page.getByRole('tab', { name: '크롤링', exact: true }).click()
    await expect(page.getByRole('button', { name: '크롤링 시작', exact: true })).toBeVisible()
    await page.getByText('실행 진단').click()
    await expect(
      page.getByRole('checkbox', { name: '파서 실패 원본 로컬 보관' }),
    ).not.toBeChecked()
  } finally {
    await context.close()
  }
})

for (const target of [
  { id: 'kissjav-most-popular-week', name: 'KissJAV', origin: 'https://kissjav.li', start: '/most-popular/?sort_by=video_viewed_week' },
  { id: 'missav-weekly-views', name: '123AV', origin: 'https://123av.com', start: '/ko/all?sort=week' },
]) {
  test(`${target.name} collects a bounded range, scans duplicate pages, and preserves saved progress`, async () => {
    test.setTimeout(90_000)
    const context = await launchExtensionContext()
    const visits: number[] = []
    let documentRequests = 0
    let malformedNext = false
    let ajaxEnabled = false
    let holdSecondPage = false
    let releaseSecondPage: (() => void) | undefined
    const isKiss = target.name === 'KissJAV'
    const href = (page: number) => isKiss
      ? `/most-popular/${page === 1 ? '' : `${page}/`}?sort_by=video_viewed_week`
      : `/ko/all?sort=week${page === 1 ? '' : `&page=${page}`}`
    const row = (id: string, title: string) => isKiss
      ? `<a href="/video/${id}/" title="${title}"><img data-original="https://images.test/${id}.png"></a>`
      : `<div class="card"><img class="card__img" src="https://images.test/${id}.png"><a class="card__link" href="/ko/v/${id}">${title}</a></div>`
    await context.route('https://other.test/**', (route) => route.fulfill({ body: '<h1>Other tab</h1>' }))
    await context.route('https://images.test/**', (route) => route.fulfill({ status: 404 }))
    await context.route(isKiss ? /^https:\/\/kissjav\.(?:li|com)\// : `${target.origin}/**`, async (route) => {
      const url = new URL(route.request().url())
      const page = Number(isKiss ? url.searchParams.get('from') ?? url.pathname.match(/\/most-popular\/(\d+)/)?.[1] ?? '1' : url.searchParams.get('page') ?? '1')
      visits.push(page)
      if (page === 2 && holdSecondPage) await new Promise<void>((resolve) => { releaseSecondPage = resolve })
      if (route.request().isNavigationRequest()) documentRequests++
      expect(url.searchParams.get(isKiss ? 'sort_by' : 'sort')).toBe(isKiss ? 'video_viewed_week' : 'week')
      const rows = row('known', 'Known video') + (page === 3 ? row('later', 'Later video') : '')
      const next = malformedNext && page === 2 ? 'https://other.test/' : href(page + 1)
      if (isKiss) {
        const button = (p: number, text: string, css = '', link = ajaxEnabled && p === 3 ? href(1) : href(p)) =>
          `<a href="${link}" class="${css}" ${ajaxEnabled ? 'data-action="ajax"' : ''} data-block-id="list_videos_common_videos_list" data-container-id="list_videos_common_videos_list_pagination" data-parameters="sort_by:video_viewed_week;from:${p}">${text}</a>`
        const listing = `<section id="list_videos_common_videos_list"><main id="list_videos_common_videos_list_items">${rows}</main>
          <div id="list_videos_common_videos_list_pagination" class="pagination">
            ${[1, 2, 3].map((p) => p === page ? `<a class="active">${p}</a>` : button(p, String(p))).join('')}
            ${page > 1 ? button(page - 1, 'Prev', 'prev') : ''}
            ${page < 3 ? button(page + 1, 'Next', 'next', next) : ''}
          </div></section>`
        if (url.searchParams.get('mode') === 'async') {
          if (page === 2) await new Promise((resolve) => setTimeout(resolve, 900))
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: listing })
        }
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${listing}<script>
          window.documentToken = Math.random();
          document.addEventListener('click', async (event) => {
            const link = event.target.closest('a[data-action="ajax"]');
            if (!link) return;
            if (!${JSON.stringify(ajaxEnabled)}) return;
            event.preventDefault();
            const root = document.querySelector('#list_videos_common_videos_list');
            const params = Object.fromEntries(link.dataset.parameters.split(';').map((part) => part.split(':')));
            root.insertAdjacentHTML('beforeend', '<div class="blockOverlay"></div>');
            root.querySelector('a.active').textContent = params.from;
            if (params.from === '2') root.querySelector('main').innerHTML = ${JSON.stringify(row('stale', 'Stale list'))};
            const url = new URL(location.href);
            url.searchParams.set('mode', 'async'); url.searchParams.set('function', 'get_block');
            url.searchParams.set('block_id', link.dataset.blockId);
            Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
            root.outerHTML = await (await fetch(url)).text();
          });
        </script></body></html>` })
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
        <section id="${isKiss ? 'list_videos_common_videos_list' : 'listing'}"><main>${page === 2 ? row('stale', 'Stale list') : rows}</main></section>
        <div ${isKiss ? 'id="list_videos_common_videos_list_pagination" class="pagination"' : 'class="pager"'}>
          ${[1, 2, 3].map((p) => p === (page === 2 ? 1 : page)
            ? `<a class="${isKiss ? 'active' : 'is-on'}" ${isKiss ? '' : 'aria-current="page"'}>${p}</a>`
            : `<a href="${href(p)}">${p}</a>`).join('')}
          ${page < 3 ? `<a class="next" rel="next" href="${next}">Next</a>` : ''}
        </div>
        ${page === 2 ? `<script>setTimeout(() => {
          document.querySelector('main').innerHTML = ${JSON.stringify(rows)};
          document.querySelector('a.${isKiss ? 'active' : 'is-on'}').outerHTML = '<a href="${href(1)}">1</a>';
          document.querySelector('${isKiss ? '.pagination' : '.pager'} a:nth-child(2)').outerHTML = '<a class="${isKiss ? 'active' : 'is-on'}" ${isKiss ? '' : 'aria-current="page"'}>2</a>';
        }, 900)</script>` : ''}
      </body></html>` })
    })
    try {
      const extensionId = await getExtensionId(context)
      const panel = await context.newPage()
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
      await resetExtensionData(panel)
      if (isKiss) {
        await panel.evaluate(() => localStorage.setItem('maltlock:site-urls', JSON.stringify({
          'kissjav-most-popular-week': 'https://kissjav.com/most-popular/?sort_by=video_viewed_week',
        })))
        await panel.reload()
        await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
        await panel.getByText('사이트 주소 설정', { exact: false }).click()
        await expect(panel.getByLabel('KissJAV URL 커스터마이즈')).toHaveValue(target.origin + target.start)
        // A live old-domain setting must also work with a tab already redirected to li.
        await panel.getByLabel('KissJAV URL 커스터마이즈').fill('https://kissjav.com' + target.start)
      }
      const site = await context.newPage()
      await site.goto(target.origin + target.start)
      const waitForSecondPage = () => context.waitForEvent('request', { predicate: (request) =>
        isKiss ? new URL(request.url()).origin === target.origin && (ajaxEnabled
          ? new URL(request.url()).searchParams.get('from') === '2' : request.url() === target.origin + href(2))
          : request.url() === target.origin + href(2) })
      await site.bringToFront()
      await panel.getByRole('button', { name: new RegExp(target.name) }).click()
      if (isKiss) {
        await expect(site).toHaveURL(target.origin + target.start)
        await site.waitForLoadState('load')
      }
      const start = panel.getByRole('button', { name: '크롤링 시작', exact: true })
      const status = panel.getByRole('status').first()
      let initialDocumentRequests = documentRequests
      const readSaved = () => panel.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('maltlock-db')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const rows = await new Promise<Array<{ siteId: string; title: string; url: string; previewImageUrl: string }>>((resolve, reject) => {
          const request = db.transaction('items').objectStore('items').getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        db.close()
        return rows.map(({ siteId, title, url, previewImageUrl }) => ({ siteId, title, url, previewImageUrl }))
      })
      await expect(panel.getByLabel(`${target.name} 수집 범위`)).toHaveValue('current')
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
      await expect(status).toContainText('신규 1건')
      await expect(panel.locator('#step-list')).toBeVisible()
      if (isKiss) {
        expect((await readSaved())[0].url).toBe('https://kissjav.li/video/known/')
        await site.goto(target.origin + target.start)
      }
      const documentToken = isKiss ? await site.evaluate(() => (window as unknown as { documentToken: number }).documentToken) : undefined
      initialDocumentRequests = documentRequests
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await panel.getByLabel(`${target.name} 수집 범위`).selectOption('all')
      await expect(panel.getByLabel('시작 페이지', { exact: true })).toHaveValue('1')
      await expect(panel.getByLabel('끝 페이지', { exact: true })).toHaveValue('3')
      visits.length = 0
      const secondPage = waitForSecondPage()
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
      await secondPage
      await panel.getByRole('tab', { name: '수집결과', exact: true }).click()
      const other = await context.newPage()
      await other.goto('https://other.test/')
      await other.bringToFront()
      await expect(status).toContainText('범위 수집 완료 (1–3페이지) · 3페이지 처리 · 신규 1건 저장 · 정확 중복 3건', { timeout: 15_000 })
      expect(visits).toEqual([1, 2, 3])
      if (isKiss) {
        expect(documentRequests).toBe(initialDocumentRequests + 3)
        await expect(site).toHaveURL(target.origin + href(3))
        expect(await site.evaluate(() => (window as unknown as { documentToken: number }).documentToken)).not.toBe(documentToken)
      }
      await expect(other).toHaveURL('https://other.test/')
      await expect(panel.getByText('Later video', { exact: true })).toBeVisible()
      const saved = await readSaved()
      expect(saved.map((item) => item.title).sort()).toEqual(['Known video', 'Later video'])
      expect(saved.every((item) => item.siteId === target.id && item.previewImageUrl.startsWith('https://images.test/'))).toBe(true)
      expect(saved.every((item) => !/[?&](page|sort|sort_by)=/.test(item.url))).toBe(true)
      if (isKiss) {
        // Normal document navigation is the live site's primary flow; also retain AJAX coverage.
        ajaxEnabled = true
        await site.goto(target.origin + target.start)
        initialDocumentRequests = documentRequests
      }
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await site.bringToFront()
      visits.length = 0
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
      await expect(status).toContainText('범위 수집 완료 (1–3페이지) · 3페이지 처리 · 신규 0건 저장', { timeout: 15_000 })
      await expect(panel.locator('#step-list')).toBeVisible()
      expect(visits).toEqual([1, 2, 3])
      if (isKiss) {
        expect(documentRequests).toBe(initialDocumentRequests + 1)
        await expect(site).toHaveURL(target.origin + target.start)
      }

      visits.length = 0
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await panel.getByLabel('시작 페이지', { exact: true }).fill('2')
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await panel.getByLabel('끝 페이지', { exact: true }).fill('2')
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
      await expect(status).toContainText('범위 수집 완료 (2–2페이지) · 1페이지 처리')
      await expect(panel.locator('#step-list')).toBeVisible()
      expect(visits).toEqual([1, 2])
      if (isKiss) {
        const response = await panel.evaluate(async (target) => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
          return chrome.runtime.sendMessage({ type: 'CRAWL_ACTIVE_TAB', payload: {
            siteId: target.id, targetUrl: target.origin + target.start, tabId: tab.id,
            expectedTabUrl: tab.url, expectedKissjavPage: 1,
          } })
        }, target)
        expect(response).toMatchObject({ ok: false, error: { code: 'TAB_URL_MISMATCH' } })
        expect((await readSaved()).length).toBe(2)
      }
      visits.length = 0
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await panel.getByLabel('시작 페이지', { exact: true }).fill('3')
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
      await expect(status).toContainText('끝 페이지는 시작 페이지 이상의 정수')
      expect(visits).toEqual([])
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await panel.getByLabel('끝 페이지', { exact: true }).fill('')
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
      await expect(status).toContainText('끝 페이지를 입력해주세요.')
      expect(visits).toEqual([])
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await panel.getByLabel('시작 페이지', { exact: true }).fill('1')
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      await panel.getByLabel('끝 페이지', { exact: true }).fill('3')

      if (isKiss) {
        // Manual AJAX navigation retains the URL and document, so both existing guards pass.
        visits.length = 0
        await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
        if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
        await expect(status).toContainText('1페이지 확인 중 · 1페이지 처리')
        await site.locator('a[data-parameters$="from:3"]').first().click()
        await expect(site.locator('#list_videos_common_videos_list_pagination a.active')).toHaveText('3')
        await expect(status).toContainText('화면의 페이지가 변경되었습니다.')
        expect(visits).toEqual([1, 3])
        expect((await readSaved()).length).toBe(2)
        expect(documentRequests).toBe(initialDocumentRequests + 1)
        visits.length = 0
      }

      holdSecondPage = true
      const stoppingPage = waitForSecondPage()
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
      await stoppingPage
      await panel.getByRole('button', { name: '수집 중지', exact: true }).click()
      releaseSecondPage?.()
      holdSecondPage = false
      await expect(status).toContainText(/수집 중지 · [12]페이지 처리/)
      expect(visits).toEqual([1, 2])
      expect((await readSaved()).length).toBe(2)

      malformedNext = true
      visits.length = 0
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
      await expect(status).toContainText('2페이지에서 일부 완료 · 2페이지 처리', { timeout: 10_000 })
      await expect(status).toContainText(isKiss ? '페이지 이동 버튼' : '다음 페이지 링크')
      expect(visits).toEqual([1, 2])
      expect((await readSaved()).length).toBe(2)
      malformedNext = false
      if (isKiss) await site.goto(target.origin + target.start)
      visits.length = 0
      const navigatingPage = waitForSecondPage()
      await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
      if (isKiss) initialDocumentRequests = documentRequests
      await start.click()
      await navigatingPage
      await site.goto('https://other.test/')
      await expect(panel.locator('#step-list')).toBeVisible({ timeout: 10_000 })
      await expect(status).toContainText('일부 완료')
      await expect(site).toHaveURL('https://other.test/')
      expect(visits).toEqual([1, 2])
      expect((await readSaved()).length).toBe(2)
    } finally {
      releaseSecondPage?.()
      await context.close()
    }
  })
}

test('step views keep the list usable in a short panel without moving the browsing tab', async ({ browserName }, testInfo) => {
  const context = await launchExtensionContext()
  await context.route('https://other.test/**', (route) => route.fulfill({ body: '<h1>Keep this tab</h1>' }))
  await context.route('https://images.test/thumbnail.png', (route) => route.fulfill({
    contentType: 'image/png', body: readFileSync(path.join(resolveExtensionDistPath(), 'icons/maltlock-128.png')),
  }))
  try {
    const extensionId = await getExtensionId(context)
    const panel = await context.newPage()
    await panel.setViewportSize({ width: 400, height: 600 })
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
    await resetExtensionData(panel)
    await seedThumbnailItem(panel)
    await panel.evaluate(async () => {
      const request = indexedDB.open('maltlock-db')
      const database = await new Promise<IDBDatabase>((resolve) => { request.onsuccess = () => resolve(request.result) })
      const transaction = database.transaction('items', 'readwrite')
      for (let i = 0; i < 30; i++) {
        transaction.objectStore('items').put({
          id: `browse-${i}`, siteId: 'kone-pornvideo-hot', title: `저장한 글 ${crypto.randomUUID()}`,
          url: `https://kone.gg/s/pornvideo/browse-${i}`, crawledAt: Date.now() + i,
          summary: i === 29 ? 'https://reference.test/keep-this-summary' : undefined,
        })
        transaction.objectStore('items').put({
          id: `browse-nimi-${i}`, siteId: 'nimi-tw-ranking', title: `주간 인기 목록에서 수집한 영상 ${i}`,
          url: `https://media.test/review-${i}.mp4`, summary: `https://www.instagram.com/reel/review-${i}/`,
          previewImageUrl: i === 29 ? `chrome-extension://${location.host}/icons/maltlock-128.png` : undefined,
          sourcePlatform: 'ig', crawledAt: Date.now() + i,
        })
      }
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
      database.close()
    })
    await panel.reload()
    const site = await context.newPage()
    await site.goto('https://other.test/keep')
    await site.bringToFront()
    await panel.getByRole('tab', { name: '수집결과', exact: true }).click()
    await panel.getByRole('button', { name: /^Kone\b/ }).click()
    await expect(site).toHaveURL('https://other.test/keep')
    await expect(panel.locator('#step-list .section-heading')).toContainText('30건')
    await expect(panel.locator('.item-summary').first()).toHaveText('https://reference.test/keep-this-summary')
    await expect(panel.getByRole('tab')).toHaveCount(2)
    await expect(panel.locator('#step-crawl')).toBeHidden()
    for (const viewport of [{ width: 400, height: 600 }, { width: 320, height: 480 }, { width: 400, height: 400 }]) {
      await panel.setViewportSize(viewport)
      const box = await panel.locator('.item-list').boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(100)
      expect(box!.y + box!.height).toBeLessThan(viewport.height)
      expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
      await panel.locator('.item-list').evaluate((list) => { list.scrollTop = list.scrollHeight })
      expect(await panel.locator('.item-list').evaluate((list) => list.scrollTop)).toBeGreaterThan(0)
    }
    await panel.setViewportSize({ width: 400, height: 600 })
    await panel.locator('.item-list').evaluate((list) => { list.scrollTop = 0 })
    await panel.screenshot({ path: testInfo.outputPath(`list-${browserName}-400x600.png`) })
    await panel.getByRole('checkbox').first().check()
    await expect(panel.getByText('선택 1건', { exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Kone 크롤링', exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: '수집결과', exact: true }).click()
    await expect(panel.getByText('선택 1건', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: /^KissJAV\b/ }).click()
    await expect(panel.getByAltText('Thumbnail reconnect smoke item')).toBeVisible()
    await expect(site).toHaveURL('https://other.test/keep')

    // Large previews must preserve both destinations, source, selection, and keyboard controls.
    await panel.getByRole('button', { name: /^NimiWiki\b/ }).click()
    await expect(panel.locator('.item-row')).toHaveCount(30)
    const first = panel.locator('.item-row').first()
    await expect(first.locator('.item-title')).toHaveAttribute('href', 'https://www.instagram.com/reel/review-29/')
    await expect(first.getByRole('link', { name: '주간 인기 목록에서 수집한 영상 29 영상 열기', exact: true })).toHaveAttribute('href', 'https://media.test/review-29.mp4')
    await expect(first.locator('.source-platform')).toHaveText('NimiWiki · 인스타그램')
    await expect(first.locator('.item-summary')).toHaveCount(0)
    for (const viewport of [{ width: 400, height: 600 }, { width: 320, height: 480 }, { width: 280, height: 400 }]) {
      await panel.setViewportSize(viewport)
      const preview = first.locator('.item-preview')
      const previewBox = await preview.boundingBox()
      expect(previewBox!.width).toBeGreaterThan(viewport.width * .7)
      expect(previewBox!.height).toBeGreaterThanOrEqual(100)
      expect(await preview.evaluate((image) => getComputedStyle(image).objectFit)).toBe('contain')
      expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
      const remove = first.getByRole('button', { name: '주간 인기 목록에서 수집한 영상 29 삭제', exact: true })
      await remove.scrollIntoViewIfNeeded()
      await expect(remove).toBeInViewport()
      const removeBox = await remove.boundingBox()
      expect(removeBox!.width).toBeGreaterThanOrEqual(44)
      expect(removeBox!.height).toBeGreaterThanOrEqual(44)
      const selectionBox = await first.locator('.item-selection').boundingBox()
      expect(selectionBox!.width).toBeGreaterThanOrEqual(24)
      expect(selectionBox!.height).toBeGreaterThanOrEqual(44)
    }
    await panel.setViewportSize({ width: 800, height: 800 })
    const firstPreview = await first.locator('.item-preview').boundingBox()
    const secondPreview = await panel.locator('.item-row').nth(1).locator('.item-preview').boundingBox()
    expect(firstPreview!.width).toBeGreaterThan(280)
    expect(secondPreview!.x).toBeGreaterThan(firstPreview!.x + firstPreview!.width)
    await panel.setViewportSize({ width: 320, height: 480 })
    await panel.getByRole('button', { name: '선택 해제', exact: true }).click()
    await panel.getByRole('button', { name: '현재 사이트 전체 선택', exact: true }).click()
    await expect(panel.locator('.item-row-selected')).toHaveCount(30)
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('tw')
    await expect(panel.getByText('트위터에 저장된 항목이 없습니다.', { exact: true })).toBeVisible()
    await expect(panel.getByText('선택 30건', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '선택 해제', exact: true }).focus()
    await panel.keyboard.press('Enter')
    await expect(panel.getByText('선택 0건', { exact: true })).toBeVisible()
    await panel.getByLabel('NimiWiki 출처 필터').selectOption('ig')
    await panel.getByLabel('NimiWiki 출처 필터').focus()
    await panel.keyboard.press('Tab')
    await expect(panel.getByLabel('목록 관리 메뉴')).toBeFocused()
    await first.getByRole('checkbox').check()
    await panel.getByRole('button', { name: '선택 삭제', exact: true }).click()
    const dialog = panel.getByRole('dialog', { name: '일괄 삭제 확인' })
    await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeFocused()
    await panel.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(first.getByRole('checkbox')).toBeChecked()
    await expect(site).toHaveURL('https://other.test/keep')
    await context.route('https://www.instagram.com/**', (route) => route.fulfill({ body: '<h1>Original destination</h1>' }))
    await first.locator('.item-title').click()
    await expect(site).toHaveURL('https://www.instagram.com/reel/review-29/')
    await context.route('https://media.test/**', (route) => route.fulfill({ body: '<h1>Media destination</h1>' }))
    await first.getByRole('link', { name: '주간 인기 목록에서 수집한 영상 29 영상 열기', exact: true }).click()
    await expect(site).toHaveURL('https://media.test/review-29.mp4')
    const remove = first.getByRole('button', { name: '주간 인기 목록에서 수집한 영상 29 삭제', exact: true })
    await first.getByRole('link', { name: '주간 인기 목록에서 수집한 영상 29 영상 열기', exact: true }).focus()
    await panel.keyboard.press('Tab')
    await expect(remove).toBeFocused()
    expect(await remove.evaluate((button) => getComputedStyle(button).outlineStyle)).toBe('solid')
    await panel.keyboard.press('Space')
    await expect(panel.getByRole('button', { name: '주간 인기 목록에서 수집한 영상 28 삭제', exact: true })).toBeFocused()
    await expect(panel.locator('#step-list .section-heading')).toContainText('29건')
    expect((await readSavedItems(panel)).some((item) => item.id === 'browse-nimi-29')).toBe(false)
    await panel.getByRole('button', { name: '사생활 모드 OFF', exact: true }).click()
    await expect(panel.locator('.item-preview')).toHaveCount(0)
    await expect(first.getByRole('link', { name: '주간 인기 목록에서 수집한 영상 28 영상 열기', exact: true })).toBeVisible()
    const privateRemoveBox = await first.locator('.item-delete').boundingBox()
    expect(privateRemoveBox!.width).toBeGreaterThanOrEqual(44)
    expect(privateRemoveBox!.height).toBeGreaterThanOrEqual(44)
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
    await page.getByRole('tab', { name: '수집결과', exact: true }).click()

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
    await page.getByRole('tab', { name: '수집결과', exact: true }).click()

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

test('Kone collects the current list after navigation and deduplicates shifted articles', async () => {
  const context = await launchExtensionContext()
  await context.route('https://kone.gg/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body>
      <main>${new URL(route.request().url()).searchParams.get('p') === '2'
        ? '<a href="/s/pornvideo/text?mode=hot&p=2"><div title="Text article"></div></a><a href="/s/pornvideo/new?mode=hot&p=2"><div title="yuma24 (4.5GB)"></div></a>'
        : '<a href="/s/pornvideo/first?mode=hot"><div title="yuma24 (2.8GB)"></div><img src="https://images.test/first.jpg" alt="yuma24 (2.8GB)"></a><a href="/s/pornvideo/text?mode=hot"><div title="Text article"></div></a>'}</main>
      <button onclick="history.pushState({}, '', '?mode=hot&p=2'); document.querySelector('main').innerHTML = '<a href=&quot;/s/pornvideo/text?mode=hot&amp;p=2&quot;><div title=&quot;Text article&quot;></div></a><a href=&quot;/s/pornvideo/new?mode=hot&amp;p=2&quot;><div title=&quot;yuma24 (4.5GB)&quot;></div></a>'">Next page</button>
      <script>self.__next_f = []; self.__next_f.push([1, '[{"id":{"__t":"u","v":"first"},"title":"First article","preview":"https://images.test/first.jpg"}]']);</script>
    </body></html>`,
  }))
  try {
    const extensionId = await getExtensionId(context)
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
    await resetExtensionData(panel)
    const site = await context.newPage()
    await site.goto('https://kone.gg/s/pornvideo?mode=hot')
    await site.bringToFront()
    await panel.getByRole('button', { name: /Kone/ }).click()
    await expect(site.getByRole('button', { name: 'Next page' })).toBeVisible()
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByRole('button', { name: '크롤링 시작', exact: true }).click()
    await expect(panel.getByRole('status').first()).toContainText('2건 파싱, 신규 2건')
    await expect(panel.locator('#step-list')).toBeVisible()
    await expect(panel.getByRole('link', { name: 'yuma24 (2.8GB)', exact: true })).toBeVisible()

    await site.getByRole('button', { name: 'Next page' }).click()
    await expect(site).toHaveURL(/p=2/)
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.locator('.site-settings > summary').click()
    await panel.getByLabel('Kone URL 커스터마이즈').fill(site.url())
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByRole('button', { name: '크롤링 시작', exact: true }).click()
    await expect(panel.getByRole('status').first()).toContainText(/2건 파싱, 신규 1건.*정확 중복 1건/)
    const saved = await panel.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('maltlock-db')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const rows = await new Promise<Array<{ title: string; url: string }>>((resolve, reject) => {
        const request = database.transaction('items').objectStore('items').getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      database.close()
      return rows.map((row) => ({ title: row.title, url: row.url }))
    })
    expect(saved.map((row) => row.title).sort()).toEqual(['Text article', 'yuma24 (2.8GB)', 'yuma24 (4.5GB)'])
    expect(saved.every((row) => !row.url.includes('p='))).toBe(true)

    await seedThumbnailItem(panel)
    await expect(panel.locator('#step-list')).toBeVisible()
    const logsBeforeDeletion = await panel.evaluate(async () => {
      const request = indexedDB.open('maltlock-db')
      const database = await new Promise<IDBDatabase>((resolve) => { request.onsuccess = () => resolve(request.result) })
      const count = database.transaction('crawledItemLogs').objectStore('crawledItemLogs').count()
      const value = await new Promise<number>((resolve) => { count.onsuccess = () => resolve(count.result) })
      database.close()
      return value
    })
    await panel.getByRole('checkbox', { name: 'Text article 선택', exact: true }).check()
    await panel.getByRole('button', { name: '선택 삭제', exact: true }).click()
    const dialog = panel.getByRole('dialog', { name: '일괄 삭제 확인' })
    await expect(dialog).toContainText('선택한 항목 1건')
    await dialog.getByRole('button', { name: '취소', exact: true }).click()
    await expect(panel.getByRole('checkbox', { name: 'Text article 선택', exact: true })).toBeChecked()
    await panel.getByRole('button', { name: '현재 사이트 전체 선택', exact: true }).click()
    await expect(panel.getByText('선택 3건', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '선택 삭제', exact: true }).click()
    await dialog.getByRole('button', { name: '3건 삭제', exact: true }).click()
    await expect(panel.getByRole('status').first()).toContainText('항목 3건을 일괄 삭제했습니다.')
    const counts = () => panel.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('maltlock-db')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const result: Record<string, number> = {}
      for (const name of ['items', 'itemSignatures', 'crawledItemLogs']) {
        result[name] = await new Promise<number>((resolve, reject) => {
          const request = database.transaction(name).objectStore(name).count()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      }
      database.close()
      return result
    })
    expect(await counts()).toMatchObject({ items: 1, itemSignatures: 0, crawledItemLogs: logsBeforeDeletion })
    await site.bringToFront()
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByRole('button', { name: '크롤링 시작', exact: true }).click()
    await expect(panel.getByRole('status').first()).toContainText('신규 0건')
    expect((await counts()).items).toBe(1)
    await expect(panel.locator('#step-list')).toBeVisible()
    await panel.getByLabel('목록 관리 메뉴').click()
    await panel.getByRole('button', { name: '전체 사이트 항목 삭제', exact: true }).click()
    await expect(dialog).toContainText('전체 사이트 1건')
    await dialog.getByRole('button', { name: '1건 삭제', exact: true }).click()
    await expect(panel.getByRole('status').first()).toContainText('항목 1건을 일괄 삭제했습니다.')
    expect(await counts()).toMatchObject({ items: 0, itemSignatures: 0, crawledItemLogs: logsBeforeDeletion })
    await panel.reload()
    await panel.getByRole('tab', { name: '수집결과', exact: true }).click()
    await expect(panel.getByText('전체 저장: 0건', { exact: true })).toHaveText('전체 저장: 0건')
  } finally {
    await context.close()
  }
})

test('Kone automatic collection scans duplicate pages, keeps its tab, and preserves progress on stop or failure', async () => {
  test.setTimeout(90_000)
  const context = await launchExtensionContext()
  const visits: number[] = []
  let malformedNext = false
  const article = (id: string, title: string) =>
    `<a class="group/article" href="/s/pornvideo/${id}?mode=hot"><div title="${title}"></div></a>`
  await context.route('https://other.test/**', (route) => route.fulfill({ body: '<h1>Other tab</h1>' }))
  await context.route('https://kone.gg/**', (route) => {
    const page = Number(new URL(route.request().url()).searchParams.get('p') ?? '1')
    visits.push(page)
    const rows = article('known', 'Known article') + (page === 3 ? article('later', 'Later popular article') : '')
    const href = (p: number) => `${malformedNext && page === 2 && p === 3 ? 'https://other.test/' : ''}?mode=hot&p=${p}`
    const links = [1, 2, 3].map((p) => `<a href="${href(p)}" ${p === (page === 2 ? 1 : page) ? 'aria-current="page"' : ''}>${p}</a>`).join('')
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
      <main>${page === 2 ? article('stale', 'Stale previous list') : rows}</main>
      <nav aria-label="${page === 1 ? 'Pagination' : '페이지 탐색'}">${links}${page < 3 ? `<a aria-label="Next page" href="${href(page + 1)}">Next</a>` : ''}</nav>
      ${page === 1 ? '<script>history.replaceState(null, "", "?mode=hot")</script>' : ''}
      ${page === 2 ? `<script>setTimeout(() => {
        document.querySelector('main').innerHTML = ${JSON.stringify(rows)};
        document.querySelector('[aria-current]').removeAttribute('aria-current');
        document.querySelector('nav a:nth-child(2)').setAttribute('aria-current', 'page');
      }, 900)</script>` : ''}
    </body></html>` })
  })
  try {
    const extensionId = await getExtensionId(context)
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
    await resetExtensionData(panel)
    const site = await context.newPage()
    await site.goto('https://kone.gg/s/pornvideo?mode=hot')
    await site.bringToFront()
    await panel.getByRole('button', { name: /Kone/ }).click()
    const start = panel.getByRole('button', { name: '크롤링 시작', exact: true })
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(panel.getByRole('status').first()).toContainText('신규 1건')
    await expect(panel.locator('#step-list')).toBeVisible()
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByLabel('코네 수집 범위').selectOption('all')
    await expect(panel.getByLabel('끝 페이지', { exact: true })).toHaveValue('5')
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByLabel('끝 페이지', { exact: true }).fill('')
    visits.length = 0
    const pageTwo = context.waitForEvent('request', { predicate: (request) => request.url().endsWith('mode=hot&p=2') })
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await pageTwo
    const other = await context.newPage()
    await other.goto('https://other.test/')
    await other.bringToFront()
    await expect(panel.getByRole('status').first()).toContainText('전체 수집 완료 · 3페이지 처리 · 신규 1건 저장', { timeout: 15_000 })
    await expect(panel.locator('#step-list')).toBeVisible()
    await expect(panel.getByRole('link', { name: 'Later popular article', exact: true })).toBeVisible()
    expect(visits).toEqual([1, 2, 3])
    await expect(other).toHaveURL('https://other.test/')
    const saved = await panel.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('maltlock-db')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const rows = await new Promise<Array<{ title: string; url: string }>>((resolve, reject) => {
        const request = db.transaction('items').objectStore('items').getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      db.close()
      return rows.map(({ title, url }) => ({ title, url }))
    })
    expect(saved.map((row) => row.title).sort()).toEqual(['Known article', 'Later popular article'])
    expect(saved.every((row) => !row.url.includes('p='))).toBe(true)

    await site.bringToFront()
    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(panel.getByRole('status').first()).toContainText('전체 수집 완료 · 3페이지 처리 · 신규 0건 저장', { timeout: 15_000 })
    await expect(panel.locator('#step-list')).toBeVisible()
    expect(visits).toEqual([1, 2, 3])

    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByLabel('시작 페이지', { exact: true }).fill('2')
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByLabel('끝 페이지', { exact: true }).fill('2')
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(panel.getByRole('status').first()).toContainText('범위 수집 완료 (2–2페이지) · 1페이지 처리', { timeout: 15_000 })
    await expect(panel.locator('#step-list')).toBeVisible()
    expect(visits).toEqual([1, 2])
    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByLabel('시작 페이지', { exact: true }).fill('3')
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(panel.getByRole('status').first()).toContainText('끝 페이지는 시작 페이지 이상의 정수')
    expect(visits).toEqual([])
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByLabel('시작 페이지', { exact: true }).fill('1')
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByLabel('끝 페이지', { exact: true }).fill('')
    const stoppingPage = context.waitForEvent('request', { predicate: (request) => request.url().endsWith('mode=hot&p=2') })
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await stoppingPage
    await panel.getByRole('button', { name: '수집 중지', exact: true }).click()
    // The in-flight page may finish before the stop click arrives; page 3 must not start.
    await expect(panel.getByRole('status').first()).toContainText(/수집 중지 · [12]페이지 처리/)
    await expect(panel.locator('#step-list')).toBeVisible()
    expect(visits).toEqual([1, 2])

    malformedNext = true
    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(panel.getByRole('status').first()).toContainText('2페이지에서 일부 완료 · 2페이지 처리', { timeout: 15_000 })
    expect(visits).toEqual([1, 2])
    await expect(panel.getByRole('status').first()).toContainText('다음 페이지 링크')
    await expect(panel.locator('#step-list')).toBeVisible()
    await panel.getByRole('tab', { name: '수집결과', exact: true }).click()
    await expect(panel.getByText('Later popular article', { exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()

    malformedNext = false
    visits.length = 0
    const navigatingPage = context.waitForEvent('request', { predicate: (request) => request.url().endsWith('mode=hot&p=2') })
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await navigatingPage
    await site.goto('https://other.test/')
    await expect(panel.locator('#step-list')).toBeVisible({ timeout: 10_000 })
    await expect(panel.getByRole('status').first()).toContainText('일부 완료')
    await expect(site).toHaveURL('https://other.test/')
    expect(visits).toEqual([1, 2])
  } finally {
    await context.close()
  }
})

test('TwiDouga automatic collection follows 11–20 even after duplicates and safely stops with saved progress', async () => {
  const context = await launchExtensionContext()
  const visits: number[] = []
  let malformedNext = false
  let holdSecondPage = false
  let releaseSecondPage: (() => void) | undefined
  const row = (rank: number, id: string) => `<div class="rank-item"
    data-video="https://video.twimg.com/amplify_video/${id}/vid/avc1/640x360/video.mp4"
    data-image="https://pbs.twimg.com/amplify_video_thumb/${id}/img/preview.jpg"
    data-url="https://x.com/example/status/${id}"><div class="rank-badge">${rank}위</div></div>`
  await context.route('https://other.test/**', (route) => route.fulfill({ body: '<h1>Other tab</h1>' }))
  await context.route('https://pbs.twimg.com/**', (route) => route.fulfill({ status: 404 }))
  await context.route('https://www.twidouga.net/**', async (route) => {
    const page = route.request().url().includes('ranking_t2.php') ? 2 : 1
    visits.push(page)
    if (page === 2 && holdSecondPage) await new Promise<void>((resolve) => { releaseSecondPage = resolve })
    const rows = page === 1 ? row(1, '900001') : row(11, '900001') + row(12, '900002')
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
      <div class="rank-tabs"><span class="rank-tab-btn" data-active="true">1~10위</span>
        <a class="rank-tab-btn" href="${malformedNext ? 'https://other.test/ranking_t2.php' : 'ranking_t2.php'}">11~20위</a></div>
      <main>${page === 1 ? rows : row(1, '900099')}</main>
      <div id="canary" style="display:none">${row(99, '900098')}</div>
      <script>document.getElementById('canary').remove();
      ${page === 2 ? `setTimeout(() => {
        document.querySelector('main').innerHTML = ${JSON.stringify(rows)};
        document.querySelector('[data-active]').textContent = '11~20위';
      }, 900);` : ''}</script>
    </body></html>` })
  })
  try {
    const extensionId = await getExtensionId(context)
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
    await resetExtensionData(panel)
    const site = await context.newPage()
    await site.goto('https://www.twidouga.net/ko/ranking_t1.php')
    await site.bringToFront()
    await panel.getByRole('button', { name: /TwiDouga/ }).click()
    const start = panel.getByRole('button', { name: '크롤링 시작', exact: true })
    const status = panel.getByRole('status').first()
    const readSaved = () => panel.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('maltlock-db')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const rows = await new Promise<Array<{ url: string; title: string; summary: string; previewImageUrl: string }>>((resolve, reject) => {
        const request = db.transaction('items').objectStore('items').getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      db.close()
      return rows.map(({ url, title, summary, previewImageUrl }) => ({ url, title, summary, previewImageUrl }))
    })
    await expect(panel.getByLabel('TwiDouga 수집 범위')).toHaveValue('current')
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(status).toContainText('신규 1건')
    await expect(panel.locator('#step-list')).toBeVisible()
    await expect(site).toHaveURL('https://www.twidouga.net/ko/ranking_t1.php')
    expect((await readSaved()).length).toBe(1)
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await panel.getByLabel('TwiDouga 수집 범위').selectOption('all')
    visits.length = 0
    const secondPage = context.waitForEvent('request', { predicate: (request) => request.url().endsWith('/ko/ranking_t2.php') })
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await secondPage
    await panel.getByRole('tab', { name: '수집결과', exact: true }).click()
    const other = await context.newPage()
    await other.goto('https://other.test/')
    await other.bringToFront()
    await expect(status).toContainText('1–20위 수집 완료 · 2페이지 처리 · 신규 1건 저장 · 정확 중복 2건', { timeout: 15_000 })
    expect(visits).toEqual([1, 2])
    await expect(site).toHaveURL('https://www.twidouga.net/ko/ranking_t2.php')
    await expect(other).toHaveURL('https://other.test/')
    await expect(panel.getByText('12위 - https://x.com/i/status/900002', { exact: true })).toBeVisible()
    const saved = await readSaved()
    expect(saved.length).toBe(2)
    expect(saved.find((item) => item.url.includes('/900002/'))).toMatchObject({
      title: '12위 - https://x.com/i/status/900002', summary: 'https://x.com/i/status/900002',
      previewImageUrl: 'https://pbs.twimg.com/amplify_video_thumb/900002/img/preview.jpg',
    })
    expect(saved.some((item) => /90009[89]/.test(item.url))).toBe(false)
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await site.bringToFront()
    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(status).toContainText('1–20위 수집 완료 · 2페이지 처리 · 신규 0건 저장', { timeout: 15_000 })
    await expect(panel.locator('#step-list')).toBeVisible()
    expect(visits).toEqual([1, 2])

    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    holdSecondPage = true
    const stoppingPage = context.waitForEvent('request', { predicate: (request) => request.url().endsWith('/ko/ranking_t2.php') })
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await stoppingPage
    await panel.setViewportSize({ width: 320, height: 400 })
    await panel.getByRole('tab', { name: '수집결과', exact: true }).click()
    await expect(panel.getByRole('button', { name: '수집 중지', exact: true })).toBeInViewport()
    expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await panel.getByRole('button', { name: '수집 중지', exact: true }).click()
    releaseSecondPage?.()
    holdSecondPage = false
    await expect(status).toContainText('수집 중지 · 1페이지 처리')
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    expect(visits).toEqual([1, 2])
    expect((await readSaved()).length).toBe(2)

    malformedNext = true
    visits.length = 0
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await expect(status).toContainText('1–10위에서 일부 완료 · 1페이지 처리')
    await expect(status).toContainText('11–20위 버튼의 페이지 링크')
    expect(visits).toEqual([1])
    expect((await readSaved()).length).toBe(2)

    malformedNext = false
    visits.length = 0
    const navigatingPage = context.waitForEvent('request', { predicate: (request) => request.url().endsWith('/ko/ranking_t2.php') })
    await panel.getByRole('tab', { name: '크롤링', exact: true }).click()
    await start.click()
    await navigatingPage
    await site.goto('https://other.test/')
    await expect(panel.locator('#step-list')).toBeVisible({ timeout: 10_000 })
    await expect(status).toContainText('일부 완료')
    await expect(site).toHaveURL('https://other.test/')
    expect(visits).toEqual([1, 2])
    expect((await readSaved()).length).toBe(2)
  } finally {
    releaseSecondPage?.()
    await context.close()
  }
})
