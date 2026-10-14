import { delay, waitForSnapshot, type AutoCrawlProgress } from './auto-crawl'
import { sendRuntimeRequest } from './runtime-client'
import type { CrawlSummary } from '../types/contracts'

function rankingUrl(input: string): URL {
  const url = new URL(input)
  if (url.origin !== 'https://www.twidouga.net' || !/^\/ko\/ranking_t[12]\.php$/.test(url.pathname)) {
    throw new Error('TwiDouga 24시간 랭킹의 1–10위 또는 11–20위 페이지에서 시작해주세요.')
  }
  url.hash = ''
  return url
}

function sameUrl(first: string | undefined, second: string): boolean {
  if (!first) return false
  try {
    return rankingUrl(first).href === rankingUrl(second).href
  } catch {
    return false
  }
}

export async function crawlTwidougaPages(options: {
  tabId: number
  documentId: string
  targetUrl: string
  captureFailurePayload: boolean
  signal: AbortSignal
  onProgress: (progress: AutoCrawlProgress) => void
}): Promise<{ progress: AutoCrawlProgress; status: 'success' | 'partial' | 'stopped'; detail?: string }> {
  const { signal, onProgress } = options
  const progress: AutoCrawlProgress = {
    page: 1, completedPages: 0, insertedCount: 0, duplicateCount: 0, rejectedCount: 0,
  }
  try {
    const tab = await chrome.tabs.get(options.tabId)
    if (tab?.id === undefined || !tab.url) throw new Error('수집할 TwiDouga 탭을 찾을 수 없습니다.')
    rankingUrl(tab.url)
    const start = rankingUrl(options.targetUrl)
    start.pathname = '/ko/ranking_t1.php'
    start.search = ''
    let url = start.href
    let previousUrl = tab.url
    // ponytail: panel owns these two pages; closing it stops after the in-flight save.
    for (const page of [1, 2]) {
      progress.page = page
      onProgress({ ...progress })
      signal.throwIfAborted()
      const current = await chrome.tabs.get(tab.id)
      if (!sameUrl(current.url, previousUrl) || (current.pendingUrl && !sameUrl(current.pendingUrl, previousUrl))) {
        throw new Error('수집 탭이 다른 페이지로 이동했습니다. 자동 수집을 중단합니다.')
      }
      const [before] = await waitForSnapshot(chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.href }), 15_000, signal)
      if (!before?.documentId) throw new Error('수집할 페이지 문서를 확인하지 못했습니다.')
      if (page === 1 && before.documentId !== options.documentId) throw new Error('수집 탭의 문서가 변경되었습니다. 자동 수집을 중단합니다.')
      const latest = await chrome.tabs.get(tab.id)
      if (!sameUrl(before.result, previousUrl) || !sameUrl(latest.url, before.result!) ||
        (latest.pendingUrl && !sameUrl(latest.pendingUrl, previousUrl))) {
        throw new Error('수집 탭이 다른 페이지로 이동했습니다. 자동 수집을 중단합니다.')
      }
      signal.throwIfAborted()
      const prepared = page === 1 && sameUrl(before.result, url)
      if (!prepared) {
        if (sameUrl(before.result, url)) await chrome.tabs.reload(tab.id)
        else await chrome.tabs.update(tab.id, { url })
      }

      const deadline = Date.now() + 15_000
      let state: { documentId: string; url: string; nextUrl?: string } | undefined
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        const loading = await chrome.tabs.get(tab.id)
        if ((!sameUrl(loading.url, previousUrl) && !sameUrl(loading.url, url)) ||
          (loading.pendingUrl && !sameUrl(loading.pendingUrl, url))) {
          throw new Error('수집 탭이 다른 페이지로 이동했습니다. 자동 수집을 중단합니다.')
        }
        if (sameUrl(loading.url, url) && loading.status === 'complete') {
          const [result] = await waitForSnapshot(chrome.scripting.executeScript({
            target: { tabId: tab.id },
            args: [page],
            func: (page: number) => {
              const active = Array.from(document.querySelectorAll('.rank-tabs [data-active="true"]'))
                .some((element) => element.textContent?.trim() === (page === 1 ? '1~10위' : '11~20위'))
              const rows = Array.from(document.querySelectorAll<HTMLElement>('.rank-item[data-video]'))
                .filter((element) => element.getClientRects().length > 0 &&
                  element.dataset.video?.startsWith('https://video.twimg.com/'))
              const ranks = rows.map((element) => Number(element.querySelector('.rank-badge')?.textContent?.match(/\d+/)?.[0]))
              const next = Array.from(document.querySelectorAll<HTMLAnchorElement>('.rank-tabs a.rank-tab-btn[href]'))
                .find((element) => element.textContent?.trim() === '11~20위')
              return {
                url: location.href,
                ready: document.readyState === 'complete' && active && ranks.length > 0 &&
                  ranks.every((rank) => rank >= (page - 1) * 10 + 1 && rank <= page * 10),
                nextUrl: next?.href,
              }
            },
          }), deadline - Date.now(), signal)
          if (result?.documentId && (prepared || result.documentId !== before.documentId) &&
            result.result?.ready && sameUrl(result.result.url, url)) {
            state = { ...result.result, documentId: result.documentId }
            break
          }
        }
        await delay(300, signal)
      }
      if (!state) throw new Error('랭킹 페이지 로딩을 확인하지 못했습니다. TwiDouga 화면의 오류 안내를 확인해주세요.')
      signal.throwIfAborted()
      const response = await sendRuntimeRequest<CrawlSummary>({
        type: 'CRAWL_ACTIVE_TAB',
        payload: { siteId: 'twidouga-ranking-t1', targetUrl: options.targetUrl,
          tabId: tab.id, expectedTabUrl: state.url, expectedDocumentId: state.documentId,
          captureFailurePayload: options.captureFailurePayload },
      })
      if (!response.ok) throw new Error(response.error.message)
      progress.completedPages++
      progress.insertedCount += response.data.insertedCount
      progress.duplicateCount += response.data.exactDuplicateCount
      progress.rejectedCount += response.data.rejectedCount
      onProgress({ ...progress })
      if (response.data.status === 'partial') throw new Error('일부 항목을 저장하지 못해 이 페이지에서 중단했습니다.')
      signal.throwIfAborted()
      if (page === 2) return { progress, status: 'success' }
      if (!state.nextUrl || new URL(state.nextUrl).origin !== start.origin ||
        new URL(state.nextUrl).pathname !== '/ko/ranking_t2.php') {
        throw new Error('11–20위 버튼의 페이지 링크를 확인하지 못했습니다.')
      }
      previousUrl = url
      url = rankingUrl(state.nextUrl).href
      await delay(1_000, signal)
    }
    return { progress, status: 'stopped' }
  } catch (error) {
    return {
      progress, status: signal.aborted ? 'stopped' : 'partial',
      detail: signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
    }
  }
}
