import { delay, type AutoCrawlProgress } from './auto-crawl'
import { getNimiPlatform, NIMI_PLATFORMS, NIMI_PLATFORM_LABELS } from './nimi'
import { sendRuntimeRequest } from './runtime-client'
import type { CrawlSummary } from '../types/contracts'
import { saveCrawlRun } from '../db/repository'

export interface NimiCrawlProgress extends AutoCrawlProgress {
  failures: string[]
}

function sameUrl(first: string | undefined, second: string): boolean {
  if (!first) return false
  try {
    const urls = [first, second].map((input) => {
      const url = new URL(input)
      url.hash = ''
      url.searchParams.sort()
      return url.href
    })
    return urls[0] === urls[1]
  } catch { return false }
}

export async function crawlNimiPlatforms(options: {
  targetUrl: string
  captureFailurePayload: boolean
  signal: AbortSignal
  onProgress: (progress: NimiCrawlProgress) => void
}): Promise<{ progress: NimiCrawlProgress; status: 'success' | 'partial' | 'stopped'; detail?: string }> {
  const { signal } = options
  const progress: NimiCrawlProgress = { page: 1, completedPages: 0, insertedCount: 0, duplicateCount: 0, rejectedCount: 0, failures: [] }
  const report = () => options.onProgress({ ...progress, failures: [...progress.failures] })
  const tabMoved = new Error('수집 탭이 다른 페이지로 이동했습니다. 자동 수집을 중단합니다.')
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab?.id === undefined || !tab.url || !getNimiPlatform(tab.url) || !getNimiPlatform(options.targetUrl)) {
      throw new Error('NimiWiki 플랫폼 목록에서 자동 수집을 시작해주세요.')
    }
    const origin = /^video1?\.nimi\.wiki$/.test(new URL(tab.url).hostname) ? new URL(tab.url).origin : 'https://video1.nimi.wiki'
    let previousUrl = tab.url
    let previousPendingUrl: string | undefined
    // ponytail: panel owns the four-platform loop; closing it stops after the in-flight save.
    for (const [index, platform] of NIMI_PLATFORMS.entries()) {
      progress.page = index + 1
      report()
      signal.throwIfAborted()
      const current = await chrome.tabs.get(tab.id)
      if ((!sameUrl(current.url, previousUrl) && !sameUrl(current.url, previousPendingUrl ?? previousUrl)) ||
        (current.pendingUrl && !sameUrl(current.pendingUrl, previousPendingUrl ?? previousUrl))) throw tabMoved
      const url = `${origin}/${platform}/ranking?sort=plays&period=week`
      const startedAt = Date.now()
      let requested = false
      let navigated = false
      try {
        const [before] = await Promise.race([
          chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.href }),
          delay(1_500, signal).then(() => []),
        ])
        if (!before?.documentId) throw new Error('수집할 페이지 문서를 확인하지 못했습니다.')
        const latest = await chrome.tabs.get(tab.id)
        if ((!sameUrl(before.result, previousUrl) && !sameUrl(before.result, previousPendingUrl ?? previousUrl)) ||
          !sameUrl(latest.url, before.result!) ||
          (latest.pendingUrl && !sameUrl(latest.pendingUrl, previousPendingUrl ?? previousUrl))) throw tabMoved
        signal.throwIfAborted()
        if (sameUrl(before.result, url)) await chrome.tabs.reload(tab.id)
        else await chrome.tabs.update(tab.id, { url })
        navigated = true
        const deadline = Date.now() + 15_000
        let state: { documentId: string; url: string } | undefined
        while (Date.now() < deadline) {
          signal.throwIfAborted()
          const loading = await chrome.tabs.get(tab.id)
          if ((!sameUrl(loading.url, previousUrl) && !sameUrl(loading.url, previousPendingUrl ?? previousUrl) && !sameUrl(loading.url, url)) ||
            (loading.pendingUrl && !sameUrl(loading.pendingUrl, url))) throw tabMoved
          if (sameUrl(loading.url, url) && loading.status === 'complete') {
            const [snapshot] = await Promise.race([
              chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [platform], func: (platform: string) => ({
                url: location.href,
                ready: document.readyState === 'complete' && document.querySelector('.video-page')?.getAttribute('data-platform') === platform,
              }) }).catch(() => []),
              delay(Math.min(1_500, Math.max(1, deadline - Date.now())), signal).then(() => []),
            ])
            if (snapshot?.documentId && snapshot.documentId !== before.documentId && snapshot.result?.ready && sameUrl(snapshot.result.url, url)) {
              state = { documentId: snapshot.documentId, url: snapshot.result.url }
              break
            }
          }
          await delay(150, signal)
        }
        if (!state) throw new Error('15초 안에 NimiWiki 플랫폼 페이지를 확인하지 못했습니다.')
        signal.throwIfAborted()
        requested = true
        const response = await sendRuntimeRequest<CrawlSummary>({ type: 'CRAWL_ACTIVE_TAB', payload: {
          siteId: 'nimi-tw-ranking', targetUrl: options.targetUrl, tabId: tab.id,
          expectedTabUrl: state.url, expectedDocumentId: state.documentId,
          captureFailurePayload: options.captureFailurePayload,
        } })
        if (!response.ok) throw new Error(response.error.message)
        progress.completedPages++
        progress.insertedCount += response.data.insertedCount
        progress.duplicateCount += response.data.exactDuplicateCount
        progress.rejectedCount += response.data.rejectedCount
        if (response.data.status === 'partial') throw new Error('일부 항목을 저장하지 못했습니다.')
      } catch (error) {
        if (signal.aborted || error === tabMoved) throw error
        const message = error instanceof Error ? error.message : String(error)
        progress.failures.push(`${NIMI_PLATFORM_LABELS[platform]}: ${message}`)
        if (!requested) await saveCrawlRun({ runId: crypto.randomUUID(), siteId: 'nimi-tw-ranking',
          startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt,
          status: 'failed', stage: 'collect', tabUrl: url, errorCode: 'CONTENT_SCRIPT_UNAVAILABLE', errorDetail: message,
        })
      }
      const after = await chrome.tabs.get(tab.id)
      if ((!sameUrl(after.url, previousUrl) && !sameUrl(after.url, previousPendingUrl ?? previousUrl) && !sameUrl(after.url, url)) ||
        (after.pendingUrl && !sameUrl(after.pendingUrl, navigated ? url : previousPendingUrl ?? previousUrl))) throw tabMoved
      previousUrl = after.url!
      previousPendingUrl = after.pendingUrl
      report()
      signal.throwIfAborted()
      if (index < NIMI_PLATFORMS.length - 1) await delay(1_000, signal)
    }
    return { progress, status: progress.failures.length ? 'partial' : 'success', detail: progress.failures.join(' · ') || undefined }
  } catch (error) {
    return { progress, status: signal.aborted ? 'stopped' : 'partial',
      detail: signal.aborted ? undefined : [error instanceof Error ? error.message : String(error), ...progress.failures].join(' · '),
    }
  }
}
