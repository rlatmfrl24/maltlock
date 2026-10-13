import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OpenTargetSiteResult, RuntimeResponse } from '../types/contracts'

const targetUrl = 'https://kone.gg/s/pornvideo?mode=hot'
let tab: { id: number; url: string; status: string; pendingUrl?: string }
let documentId: string
let ready: boolean
let blockSnapshot: boolean
let emptyFirstSnapshot: boolean
let listener: (message: unknown, sender: object, reply: (response: RuntimeResponse<OpenTargetSiteResult>) => void) => boolean

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  tab = { id: 7, url: targetUrl, status: 'complete' }
  documentId = 'old-document'
  ready = true
  blockSnapshot = false
  emptyFirstSnapshot = false
  let snapshots = 0
  const event = { addListener: () => {} }
  vi.stubGlobal('chrome', {
    runtime: { onInstalled: event, onStartup: event, onMessage: { addListener: (handler: typeof listener) => { listener = handler } } },
    action: { onClicked: event },
    tabs: {
      query: async () => [{ ...tab }],
      get: async () => ({ ...tab }),
      update: async (_id: number, options: { url: string }) => {
        tab.pendingUrl = options.url
        tab.status = 'loading'
        return { ...tab }
      },
      onActivated: event, onUpdated: event,
    },
    scripting: { executeScript: async () => blockSnapshot ? new Promise(() => {}) : emptyFirstSnapshot && snapshots++ === 0 ? [] : [{
      documentId, frameId: 0, result: { url: tab.url, ready },
    }] },
  })
  await import('./service-worker')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function openSite(siteId = 'kone-pornvideo-hot', url = targetUrl): { task: Promise<RuntimeResponse<OpenTargetSiteResult>>; response: () => RuntimeResponse<OpenTargetSiteResult> | undefined } {
  let response: RuntimeResponse<OpenTargetSiteResult> | undefined
  const task = new Promise<RuntimeResponse<OpenTargetSiteResult>>((resolve) => {
    listener({ type: 'OPEN_TARGET_SITE', payload: { siteId, targetUrl: url, requestId: 'prepare-test' } }, {}, (value) => {
      response = value
      resolve(value)
    })
  })
  return { task, response: () => response }
}

it('waits for a new ready document even when reopening the same URL', async () => {
  const request = openSite()
  await vi.advanceTimersByTimeAsync(10)
  expect(request.response()).toBeUndefined()
  tab.status = 'complete'
  delete tab.pendingUrl
  await vi.advanceTimersByTimeAsync(500)
  expect(request.response()).toBeUndefined()
  documentId = 'new-document'
  ready = false
  await vi.advanceTimersByTimeAsync(500)
  expect(request.response()).toBeUndefined()
  ready = true
  await vi.advanceTimersByTimeAsync(500)
  expect(await request.task).toEqual({ ok: true, data: {
    siteId: 'kone-pornvideo-hot', tabId: 7, url: targetUrl, documentId: 'new-document',
  } })
})

it('rejects a user navigation during target preparation without replacing it', async () => {
  const request = openSite()
  await vi.advanceTimersByTimeAsync(10)
  tab.url = 'https://other.test/manual'
  delete tab.pendingUrl
  tab.status = 'complete'
  await vi.advanceTimersByTimeAsync(500)
  expect(await request.task).toMatchObject({ ok: false, error: { code: 'TAB_URL_MISMATCH' } })
  expect(tab.url).toBe('https://other.test/manual')
})

it('settles preparation when a document snapshot never responds', async () => {
  blockSnapshot = true
  const request = openSite()
  await vi.advanceTimersByTimeAsync(16_000)
  expect(request.response()).toMatchObject({ ok: false, error: { code: 'CONTENT_SCRIPT_UNAVAILABLE' } })
  await request.task
  expect(vi.getTimerCount()).toBe(0)
})

it('prepares a legacy KissJAV address on its supported canonical host', async () => {
  tab.url = 'https://other.test/'
  const request = openSite('kissjav-most-popular-week', 'https://kissjav.com/most-popular/?sort_by=video_viewed_week')
  await vi.advanceTimersByTimeAsync(10)
  tab.url = 'https://kissjav.li/most-popular/?sort_by=video_viewed_week'
  tab.status = 'complete'
  delete tab.pendingUrl
  documentId = 'canonical-document'
  await vi.advanceTimersByTimeAsync(500)
  expect(await request.task).toMatchObject({ ok: true, data: { url: tab.url, documentId: 'canonical-document' } })
})

it('rejects a missing original document rather than accepting an old same-URL page', async () => {
  emptyFirstSnapshot = true
  const request = openSite()
  await vi.advanceTimersByTimeAsync(10)
  tab.status = 'complete'
  delete tab.pendingUrl
  await vi.advanceTimersByTimeAsync(500)
  expect(await request.task).toMatchObject({ ok: false, error: { code: 'CONTENT_SCRIPT_UNAVAILABLE' } })
})

it('cancels blocked preparation before any late browser navigation can occur', async () => {
  blockSnapshot = true
  const request = openSite()
  await vi.advanceTimersByTimeAsync(10)
  listener({ type: 'CANCEL_TARGET_SITE', payload: { requestId: 'prepare-test' } }, {}, () => {})
  await vi.advanceTimersByTimeAsync(10)
  expect(request.response()).toMatchObject({ ok: false })
  expect(tab.pendingUrl).toBeUndefined()
  await request.task
  expect(vi.getTimerCount()).toBe(0)
})
