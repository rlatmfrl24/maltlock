import { afterEach, expect, it, vi } from 'vitest'
import { crawlRangePages } from './range-auto-crawl'
import { crawlTwidougaPages } from './twidouga-auto-crawl'
import type { RuntimeRequestMessage } from '../types/contracts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([[true, false], [false, false], [true, true]])('bounds lost navigation responses (moves: %s, loses snapshots: %s)', async (moves, losesSnapshots) => {
  vi.useFakeTimers()
  const targetUrl = 'https://kissjav.li/most-popular/?sort_by=video_viewed_week'
  const href = (page: number) => `https://kissjav.li/most-popular/${page === 1 ? '' : `${page}/`}?sort_by=video_viewed_week`
  let page = 1
  const captures: RuntimeRequestMessage[] = []
  const tab = () => ({ id: 7, url: href(page), status: 'complete' })
  vi.stubGlobal('chrome', {
    tabs: { query: async () => [tab()], get: async () => tab() },
    scripting: { executeScript: async ({ args }: { args: unknown[] }) => {
      if (args.length === 4) {
        if (moves) page = Number(args[1])
        // Chrome can lose the injection response when the click replaces its document.
        return new Promise(() => {})
      }
      if (losesSnapshots && page > 1) return new Promise(() => {})
      return [{ documentId: `document-${page}`, result: {
        url: href(page), page, ready: true, replacedItems: false, lastPage: 3,
        nextUrl: page < 3 ? href(page + 1) : undefined,
        links: [1, 2, 3].filter((p) => p !== page).map((p) => ({ href: href(p), page: p, next: p === page + 1, prev: p === page - 1 })),
      } }]
    } },
    runtime: { sendMessage: async (message: RuntimeRequestMessage) => {
      captures.push(message)
      return { ok: true, data: { status: 'success', insertedCount: 1, exactDuplicateCount: 0, rejectedCount: 0 } }
    } },
  })
  let result: Awaited<ReturnType<typeof crawlRangePages>> | undefined
  const task = crawlRangePages({ siteId: 'kissjav-most-popular-week', targetUrl,
    startPage: 1, endPage: 3, captureFailurePayload: false,
    signal: new AbortController().signal, onProgress: () => {},
  }).then((value) => { result = value })
  await vi.advanceTimersByTimeAsync(20_000)
  // Assert completion before awaiting: a never-settling click must not hang this runner.
  const success = moves && !losesSnapshots
  expect(result).toMatchObject({ status: success ? 'success' : 'partial', progress: {
    completedPages: success ? 3 : 1, insertedCount: success ? 3 : 1,
  } })
  await task
  expect(captures.map((message) => message.payload)).toEqual((success ? [1, 2, 3] : [1]).map((page) => ({
    siteId: 'kissjav-most-popular-week', targetUrl, tabId: 7, expectedTabUrl: href(page),
    expectedDocumentId: `document-${page}`, expectedKissjavPage: page, captureFailurePayload: false,
  })))
  if (!success) expect(result?.detail).toContain('15초 안에 KissJAV 새 목록')
})

it.each(['kone-pornvideo-hot', 'missav-weekly-views', 'twidouga-ranking-t1'].flatMap((siteId) =>
  ['moved-snapshot', 'moved-pending', 'lost-before', 'lost-ready', 'abort-ready'].map((mode) => [siteId, mode]),
))('protects navigation and bounds snapshot waits (%s, %s)', async (siteId, mode) => {
  vi.useFakeTimers()
  const targetUrl = siteId === 'kone-pornvideo-hot' ? 'https://kone.gg/s/pornvideo?mode=hot'
    : siteId === 'missav-weekly-views' ? 'https://123av.com/ko/all?sort=week'
      : 'https://www.twidouga.net/ko/ranking_t1.php'
  let url = targetUrl
  let pendingUrl: string | undefined
  let document = 0
  let waiting = false
  const tab = () => ({ id: 7, url, pendingUrl, status: 'complete' })
  const navigate = vi.fn(async (_: number, options?: { url: string }) => { document++; url = options?.url ?? url })
  const capture = vi.fn()
  vi.stubGlobal('chrome', {
    tabs: { query: async () => [tab()], get: async () => tab(), reload: navigate, update: navigate },
    scripting: { executeScript: async ({ args }: { args?: string[] }) => {
      if (!args) {
        if (mode === 'lost-before') return new Promise(() => {})
        if (mode === 'moved-snapshot') url = 'https://other.test/'
        if (mode === 'moved-pending') pendingUrl = 'https://other.test/'
        return [{ documentId: `document-${document}`, result: url }]
      }
      waiting = true
      return new Promise(() => {})
    } },
    runtime: { sendMessage: capture },
  })
  const controller = new AbortController()
  const options = { siteId, targetUrl, startPage: 1, endPage: 1,
    captureFailurePayload: false, signal: controller.signal, onProgress: () => {} }
  let result: Awaited<ReturnType<typeof crawlRangePages>> | undefined
  const task = (siteId === 'twidouga-ranking-t1' ? crawlTwidougaPages(options) : crawlRangePages(options))
    .then((value) => { result = value })
  if (mode === 'abort-ready') {
    await vi.advanceTimersByTimeAsync(50)
    expect(waiting).toBe(true)
    controller.abort()
    await vi.advanceTimersByTimeAsync(1)
  } else await vi.advanceTimersByTimeAsync(35_000)
  expect(result).toMatchObject({ status: mode === 'abort-ready' ? 'stopped' : 'partial', progress: { completedPages: 0 } })
  await task
  expect(capture).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  if (mode.startsWith('moved') || mode === 'lost-before') expect(navigate).not.toHaveBeenCalled()
  if (mode.startsWith('moved')) expect(result?.detail).toContain('다른 페이지로 이동')
  if (mode.startsWith('lost')) expect(result?.detail).toContain('응답 시간이 초과')
})
