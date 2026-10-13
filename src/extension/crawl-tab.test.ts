import { afterEach, expect, it, vi } from 'vitest'
import { crawlRangePages } from './range-auto-crawl'
import { crawlTwidougaPages } from './twidouga-auto-crawl'
import { crawlNimiPlatforms } from './nimi-auto-crawl'
import type { RuntimeRequestMessage } from '../types/contracts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it.each([
  ['range', 'https://kone.gg/s/pornvideo?mode=hot', 1],
  ['ranking', 'https://www.twidouga.net/ko/ranking_t1.php', 2],
  ['platforms', 'https://video1.nimi.wiki/tw/ranking?sort=plays&period=week', 4],
] as const)('keeps the prepared tab when the active tab changes (%s)', async (mode, targetUrl, pages) => {
  vi.useFakeTimers()
  let url: string = targetUrl
  let document = 0
  const captured: number[] = []
  const documents: string[] = []
  const tab = () => ({ id: 7, url, status: 'complete' })
  vi.stubGlobal('chrome', {
    tabs: {
      query: async () => [{ id: 99, url: 'https://other.test/', status: 'complete' }],
      get: async (id: number) => id === 7 ? tab() : { id, url: 'https://other.test/', status: 'complete' },
      update: async (_id: number, options: { url: string }) => { url = options.url; document++; return tab() },
      reload: async () => { document++ },
    },
    scripting: { executeScript: async ({ args }: { args?: unknown[] }) => [{ documentId: `doc-${document}`, frameId: 0,
      result: args ? { url, ready: true, lastPage: 1,
        nextUrl: url.endsWith('ranking_t1.php') ? 'https://www.twidouga.net/ko/ranking_t2.php' : undefined,
      } : url,
    }] },
    runtime: { sendMessage: async (message: RuntimeRequestMessage) => {
      if (message.type !== 'CRAWL_ACTIVE_TAB') throw new Error('Unexpected message')
      captured.push(message.payload.tabId!)
      documents.push(message.payload.expectedDocumentId!)
      return { ok: true, data: { siteId: message.payload.siteId, tabId: 7, tabUrl: url,
        runId: 'pin-test', parsedCount: 1, validCount: 1, status: 'success', insertedCount: 1,
        duplicateCount: 0, exactDuplicateCount: 0, rejectedCount: 0,
      } }
    } },
  })
  const options = { siteId: 'kone-pornvideo-hot', targetUrl, tabId: 7, documentId: 'doc-0', startPage: 1, endPage: 1,
    captureFailurePayload: false, signal: new AbortController().signal, onProgress: () => {},
  }
  const task = mode === 'range' ? crawlRangePages(options) : mode === 'ranking' ? crawlTwidougaPages(options) : crawlNimiPlatforms(options)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await task).toMatchObject({ status: 'success', progress: { completedPages: pages, insertedCount: pages } })
  expect(captured).toEqual(Array.from({ length: pages }, () => 7))
  expect(documents[0]).toBe('doc-0')
})
