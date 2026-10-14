import { afterEach, expect, it, vi } from 'vitest'
import { crawlNimiPlatforms } from './nimi-auto-crawl'
import { saveCrawlRun } from '../db/repository'
import type { CrawlActiveTabMessage } from '../types/contracts'

vi.mock('../db/repository', () => ({ saveCrawlRun: vi.fn(async () => {}) }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it.each(['success', 'timeout', 'pending', 'stopped', 'moved', 'moved-before', 'moved-after-snapshot', 'pending-after-snapshot'])('bounds platform loading and protects the target tab (%s)', async (mode) => {
  vi.useFakeTimers()
  const targetUrl = 'https://video1.nimi.wiki/tw/ranking?sort=plays&period=week'
  const signal = new AbortController()
  const movedAfterSnapshot = mode === 'moved-after-snapshot' || mode === 'pending-after-snapshot'
  const preventedNavigation = mode === 'moved-before' || movedAfterSnapshot
  let url = targetUrl
  let document = 0
  let pendingUrl: string | undefined
  let lostBefore = false
  const captures: string[] = []
  const visits: string[] = []
  const platform = () => new URL(url).pathname.split('/')[1]
  const navigate = async (next: string) => {
    visits.push(new URL(next).pathname.split('/')[1])
    if (mode === 'pending' && next.includes('/ig/')) pendingUrl = next
    else { url = next; document++; pendingUrl = undefined }
    return { id: 9, url }
  }
  vi.stubGlobal('chrome', {
    tabs: {
      query: async () => [{ id: 9, url }],
      get: async () => ({ id: 9, url, pendingUrl, status: pendingUrl || mode === 'timeout' && platform() === 'ig' ? 'loading' : 'complete' }),
      reload: async () => navigate(url), update: async (_: number, options: { url: string }) => navigate(options.url),
    },
    scripting: { executeScript: async ({ args }: { args?: string[] }) => {
      if (!args && pendingUrl && !lostBefore) { lostBefore = true; return new Promise(() => {}) }
      if (!args && mode === 'moved-before') url = 'https://other.test/'
      const snapshot = { documentId: `document-${document}`, result: args ? { url, ready: true } : url }
      if (!args && mode === 'moved-after-snapshot') url = 'https://other.test/'
      if (!args && mode === 'pending-after-snapshot') pendingUrl = 'https://other.test/'
      return [snapshot]
    } },
    runtime: { sendMessage: async (message: CrawlActiveTabMessage) => {
      expect(message.payload.expectedDocumentId).toBe(`document-${document}`)
      expect(message.payload.expectedTabUrl).toBe(url)
      expect(new URL(url).searchParams.get('period')).toBe('week')
      captures.push(platform())
      if (mode === 'stopped') signal.abort()
      if (mode === 'moved') url = 'https://other.test/'
      return { ok: true, data: { status: 'success', insertedCount: 0, exactDuplicateCount: 2, rejectedCount: 0 } }
    } },
  })
  let result: Awaited<ReturnType<typeof crawlNimiPlatforms>> | undefined
  const task = crawlNimiPlatforms({ targetUrl, tabId: 9, documentId: 'document-0', captureFailurePayload: false, signal: signal.signal, onProgress: () => {} })
    .then((value) => { result = value })
  await vi.advanceTimersByTimeAsync(25_000)
  expect(result?.status).toBe(mode === 'success' ? 'success' : mode === 'stopped' ? 'stopped' : 'partial')
  await task
  expect(visits).toEqual(preventedNavigation || mode === 'moved' || mode === 'stopped' ? [] : mode === 'pending' ? ['ig', 'bs'] : ['ig', 'tt', 'bs'])
  expect(captures).toEqual(preventedNavigation ? [] : mode === 'moved' || mode === 'stopped' ? ['tw'] : mode === 'pending' ? ['tw', 'bs'] : mode === 'timeout' ? ['tw', 'tt', 'bs'] : ['tw', 'ig', 'tt', 'bs'])
  expect(result?.progress.completedPages).toBe(captures.length)
  if (mode === 'timeout') {
    expect(result?.detail).toContain('인스타그램: 15초')
    expect(saveCrawlRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', tabUrl: 'https://video1.nimi.wiki/ig/ranking?sort=plays&period=week' }))
  }
  if (mode.startsWith('moved')) expect(url).toBe('https://other.test/')
  if (mode === 'pending-after-snapshot') expect(pendingUrl).toBe('https://other.test/')
  if (preventedNavigation) {
    expect(result?.detail).toContain('다른 페이지로 이동')
    expect(saveCrawlRun).not.toHaveBeenCalled()
  }
})
