import { sendRuntimeRequest } from './runtime-client'
import { delay, waitForSnapshot, type AutoCrawlProgress } from './auto-crawl'
import type { CrawlSummary } from '../types/contracts'
import { normalizeKissjavUrl } from '../config/targets'

interface PageState {
  documentId: string
  url: string
  ready: boolean
  nextUrl?: string
  lastPage: number
  page?: number
}

async function kissjavPage(tabId: number, scope: URL, page: number, signal: AbortSignal, previousPage?: number, previousDocumentId?: string): Promise<PageState> {
  let deadline = Date.now() + 15_000
  let movement: { from: number; to: number; href: string; token: string; documentId: string; error?: string } | undefined
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const tab = await chrome.tabs.get(tabId)
    if (!tab.url || listUrl(tab.url, 'kissjav-most-popular-week').href !== scope.href ||
      (tab.pendingUrl && listUrl(tab.pendingUrl, 'kissjav-most-popular-week').href !== scope.href)) {
      throw new Error('수집 탭이 다른 페이지로 이동했습니다. 자동 수집을 중단합니다.')
    }
    if (movement && tab.pendingUrl && !samePageUrl(tab.pendingUrl, movement.href, 'kissjav-most-popular-week')) {
      throw new Error('수집 탭이 다른 페이지로 이동했습니다. 자동 수집을 중단합니다.')
    }
    const [snapshot] = await Promise.race([chrome.scripting.executeScript({
      target: { tabId },
      args: [movement?.token ?? null],
      func: (token: string | null) => {
        const world = globalThis as typeof globalThis & { __maltlockKissjavMove?: { token: string; items: Element } }
        if (!token) delete world.__maltlockKissjavMove
        const root = document.querySelector('#list_videos_common_videos_list')
        const nav = root?.querySelector('#list_videos_common_videos_list_pagination')
        const page = Number(nav?.querySelector('a.active')?.textContent?.trim())
        const links = Array.from(nav?.querySelectorAll<HTMLAnchorElement>('a[href]:not(.active):not(.disabled)') ?? []).map((link) => ({
          href: link.href,
          page: Number(link.dataset.parameters?.match(/(?:^|;)from:(\d+)(?:;|$)/)?.[1]
            ?? link.pathname.match(/^\/most-popular(?:\/(\d+))?\/?$/)?.[1] ?? '1'),
          next: link.classList.contains('next'),
          prev: link.classList.contains('prev'),
        })).filter((link) => !link.href.endsWith('#'))
        return { url: location.href, page, links,
          replacedItems: world.__maltlockKissjavMove?.token === token &&
            root?.querySelector('#list_videos_common_videos_list_items') !== world.__maltlockKissjavMove?.items,
          ready: document.readyState === 'complete' && Number.isSafeInteger(page) && page > 0 &&
            !!root?.querySelector('#list_videos_common_videos_list_items a[href*="/video/"]') && !root.querySelector('.blockOverlay'),
          nextUrl: (links.find((link) => link.next) ?? links.find((link) => link.page === page + 1))?.href,
          lastPage: Math.max(page, ...links.map((link) => link.page).filter(Number.isSafeInteger)),
        }
      },
    }).catch((error: unknown) => {
      if (!movement) throw error
      return [] // The document may commit between tabs.get() and this synchronous snapshot.
    }), delay(Math.min(1_500, Math.max(1, deadline - Date.now())), signal).then(() => [])])
    const state = snapshot?.result
    if ((!state || !snapshot.documentId) && movement) { await delay(150, signal); continue }
    if (!state || !snapshot.documentId || listUrl(state.url, 'kissjav-most-popular-week').href !== scope.href) {
      throw new Error('수집할 KissJAV 목록을 확인하지 못했습니다.')
    }
    if (movement) {
      const newDocument = snapshot.documentId !== movement.documentId
      if ((newDocument && !samePageUrl(state.url, movement.href, 'kissjav-most-popular-week')) ||
        (!newDocument && state.page > 0 && state.page !== movement.from && state.page !== movement.to) ||
        (newDocument && state.ready && state.page !== movement.to)) {
        throw new Error('수집 중 화면의 페이지가 변경되었습니다. 자동 수집을 중단합니다.')
      }
      if (!state.ready || state.page !== movement.to || (!newDocument && !state.replacedItems)) {
        await delay(150, signal)
        continue
      }
      previousPage = movement.to
      previousDocumentId = snapshot.documentId
      movement = undefined
      deadline = Date.now() + 15_000
    }
    if ((previousPage !== undefined && state.page !== previousPage) ||
      (previousDocumentId !== undefined && snapshot.documentId !== previousDocumentId)) {
      throw new Error('수집 중 화면의 페이지가 변경되었습니다. 자동 수집을 중단합니다.')
    }
    if (!state.ready) { await delay(300, signal); continue }
    if (state.page === page) return { ...state, documentId: snapshot.documentId }
    const forward = page > state.page
    const link = (page === state.page + 1 ? state.links.find((link) => link.next) : undefined)
      ?? state.links.find((link) => link.page === page)
      ?? state.links.find((link) => forward ? link.next : link.prev)
    if (!link || !Number.isSafeInteger(link.page) || link.page < 1 ||
      (forward ? link.page <= state.page || link.page > page : link.page >= state.page || link.page < page) ||
      listUrl(link.href, 'kissjav-most-popular-week').href !== scope.href) {
      throw new Error('페이지 이동 버튼이 수집 범위를 벗어나거나 순서가 잘못되었습니다.')
    }
    const move = { from: state.page, to: link.page, href: link.href,
      token: crypto.randomUUID(), documentId: snapshot.documentId, error: undefined as string | undefined }
    movement = move
    const click = chrome.scripting.executeScript({
      target: { tabId, documentIds: [snapshot.documentId] },
      args: [state.page, link.page, link.href, move.token],
      func: (from: number, to: number, href: string, token: string) => {
        const root = document.querySelector('#list_videos_common_videos_list')
        const items = root?.querySelector('#list_videos_common_videos_list_items')
        const nav = root?.querySelector('#list_videos_common_videos_list_pagination')
        const link = Array.from(nav?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []).find((link) =>
          link.href === href && Number(link.dataset.parameters?.match(/(?:^|;)from:(\d+)(?:;|$)/)?.[1]
            ?? link.pathname.match(/^\/most-popular(?:\/(\d+))?\/?$/)?.[1] ?? '1') === to)
        if (!items || !link || Number(nav?.querySelector('a.active')?.textContent?.trim()) !== from || root?.querySelector('.blockOverlay')) {
          throw new Error('클릭 직전 화면의 페이지가 변경되었습니다.')
        }
        const world = globalThis as typeof globalThis & { __maltlockKissjavMove?: { token: string; items: Element } }
        world.__maltlockKissjavMove = { token, items }
        link.click()
        return true
      },
    }).catch((error: unknown) => {
      move.error = error instanceof Error ? error.message : String(error)
    })
    // Navigation can destroy the injection context before Chrome returns its result.
    // Observe the new document from the panel rather than waiting inside the old one.
    await Promise.race([click, delay(300, signal)])
    deadline = Date.now() + 15_000
    await delay(150, signal)
  }
  throw new Error(movement?.error ?? '15초 안에 KissJAV 새 목록을 확인하지 못했습니다. 사이트 화면을 확인해주세요.')
}

function listUrl(input: string, siteId: string): URL {
  const url = siteId === 'kissjav-most-popular-week' ? normalizeKissjavUrl(input) : new URL(input)
  if (siteId === 'kone-pornvideo-hot') {
    if (url.origin !== 'https://kone.gg' || !/^\/s\/[^/]+\/?$/.test(url.pathname)) {
      throw new Error('코네 게시판 목록에서 자동 수집을 시작해주세요.')
    }
    url.searchParams.delete('p')
    url.searchParams.set('mode', 'hot')
  } else if (siteId === 'kissjav-most-popular-week') {
    if (!/^\/most-popular(?:\/\d+)?\/?$/.test(url.pathname)) {
      throw new Error(`KissJAV 인기 목록에서 자동 수집을 시작해주세요. 현재 주소: ${input}`)
    }
    pageNumber(url, siteId)
    url.pathname = '/most-popular/'
  } else if (siteId === 'missav-weekly-views') {
    if (url.origin !== 'https://123av.com' || !/^\/[a-z]{2}\/all\/?$/.test(url.pathname)) {
      throw new Error('123AV 전체 목록에서 자동 수집을 시작해주세요.')
    }
    url.pathname = url.pathname.replace(/\/$/, '')
    url.searchParams.delete('page')
  } else {
    throw new Error('페이지 범위 자동 수집을 지원하지 않는 사이트입니다.')
  }
  url.hash = ''
  url.searchParams.sort()
  return url
}

function pageNumber(url: URL, siteId: string): number {
  const page = Number(siteId === 'kissjav-most-popular-week'
    ? url.pathname.match(/^\/most-popular(?:\/(\d+))?\/?$/)?.[1] ?? '1'
    : url.searchParams.get(siteId === 'missav-weekly-views' ? 'page' : 'p') ?? '1')
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error('페이지 번호가 올바르지 않습니다.')
  }
  return page
}

function pageUrl(base: URL, page: number, siteId: string): URL {
  const url = new URL(base)
  if (siteId === 'kissjav-most-popular-week') url.pathname = `/most-popular/${page === 1 ? '' : `${page}/`}`
  else {
    const key = siteId === 'missav-weekly-views' ? 'page' : 'p'
    if (page === 1) url.searchParams.delete(key)
    else url.searchParams.set(key, String(page))
  }
  return url
}

function samePageUrl(first: string | undefined, second: string, siteId: string): boolean {
  if (!first) return false
  try {
    const urls = [first, second].map((input) => {
      const url = siteId === 'kissjav-most-popular-week' ? normalizeKissjavUrl(input) : new URL(input)
      if (siteId === 'kissjav-most-popular-week' && !/^\/most-popular(?:\/\d+)?\/?$/.test(url.pathname)) {
        throw new Error('목록 범위를 벗어났습니다.')
      }
      return pageUrl(url, pageNumber(url, siteId), siteId)
    })
    for (const url of urls) {
      url.hash = ''
      url.searchParams.sort()
    }
    return urls[0].href === urls[1].href
  } catch {
    return false
  }
}

function nextPageUrl(current: string, next: string, siteId: string): string {
  const currentUrl = new URL(current)
  const nextUrl = new URL(next, current)
  if (
    nextUrl.origin !== currentUrl.origin ||
    (siteId !== 'kissjav-most-popular-week' && nextUrl.pathname !== currentUrl.pathname) ||
    (siteId === 'kone-pornvideo-hot' && nextUrl.searchParams.get('mode') !== 'hot') ||
    listUrl(current, siteId).href !== listUrl(nextUrl.href, siteId).href ||
    pageNumber(nextUrl, siteId) !== pageNumber(currentUrl, siteId) + 1
  ) {
    throw new Error('다음 페이지 링크가 수집 범위를 벗어나거나 순서가 잘못되었습니다.')
  }
  return nextUrl.href
}

async function waitForPage(tabId: number, expectedUrl: string, previousDocumentId: string, siteId: string, signal: AbortSignal): Promise<PageState> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const tab = await chrome.tabs.get(tabId)
    if (!samePageUrl(tab.url, expectedUrl, siteId) || (tab.pendingUrl && !samePageUrl(tab.pendingUrl, expectedUrl, siteId))) {
      throw new Error('수집 탭이 다른 페이지로 이동했습니다. 자동 수집을 중단합니다.')
    }
    if (tab.status === 'complete') {
      const [result] = await waitForSnapshot(chrome.scripting.executeScript({
        target: { tabId },
        args: [siteId],
        func: (siteId: string) => {
          const isKiss = siteId === 'kissjav-most-popular-week'
          const isAv = siteId === 'missav-weekly-views'
          if (isKiss || isAv) {
            const nav = document.querySelector(isKiss ? '#list_videos_common_videos_list_pagination' : '.pager')
            const pageOf = (input: string) => {
              const url = new URL(input)
              return Number(isKiss ? url.pathname.match(/^\/most-popular(?:\/(\d+))?\/?$/)?.[1] ?? '1' : url.searchParams.get('page') ?? '1')
            }
            const page = pageOf(location.href)
            const current = Number(nav?.querySelector(isKiss ? 'a.active' : '[aria-current="page"]')?.textContent?.trim())
            const links = Array.from(nav?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])
            const pages = links.map((link) => pageOf(link.href))
            const next = nav?.querySelector<HTMLAnchorElement>(isKiss ? 'a.next[href]' : 'a[rel="next"][href]')
              ?? links.find((_, index) => pages[index] === page + 1)
            return {
              url: location.href,
              ready: document.readyState === 'complete' && current === page &&
                !!document.querySelector(isKiss ? '#list_videos_common_videos_list a[href*="/video/"]' : '.card a.card__link[href*="/v/"]'),
              nextUrl: next?.href,
              lastPage: Math.max(page, ...pages.filter(Number.isFinite)),
            }
          }
          const nav = Array.from(document.querySelectorAll('nav')).find((element) =>
            /^\d+$/.test(element.querySelector('[aria-current="page"]')?.textContent?.trim() ?? ''),
          )
          const page = Number(new URL(location.href).searchParams.get('p') ?? '1')
          const current = Number(nav?.querySelector('[aria-current="page"]')?.textContent)
          const links = Array.from(nav?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])
          const pages = links.map((link) => Number(new URL(link.href).searchParams.get('p') ?? '1'))
          return {
            url: location.href,
            ready: document.readyState === 'complete' && current === page &&
              !document.querySelector('[role="progressbar"]') &&
              !!document.querySelector('a.group\\/article'),
            nextUrl: links.find((_, index) => pages[index] === page + 1)?.href,
            lastPage: Math.max(page, ...pages.filter(Number.isFinite)),
          }
        },
      }), deadline - Date.now(), signal)
      // Even a reload of the same URL must replace the old document before capture.
      if (result?.documentId === previousDocumentId) {
        await delay(300, signal)
        continue
      }
      const state = result?.result
      if (!state || !samePageUrl(state.url, expectedUrl, siteId)) {
        throw new Error('수집 중 대상 페이지가 변경되었습니다.')
      }
      if (state.ready && result.documentId) return { ...state, documentId: result.documentId }
    }
    await delay(300, signal)
  }
  throw new Error('페이지 로딩을 확인하지 못했습니다. 사이트 화면의 로그인·오류 안내를 확인해주세요.')
}

export async function crawlRangePages(options: {
  siteId: string
  targetUrl: string
  startPage: number
  endPage?: number
  captureFailurePayload: boolean
  signal: AbortSignal
  onProgress: (progress: AutoCrawlProgress) => void
}): Promise<{ progress: AutoCrawlProgress; status: 'success' | 'partial' | 'stopped'; detail?: string }> {
  const { siteId, signal, onProgress } = options
  const progress: AutoCrawlProgress = {
    page: options.startPage, completedPages: 0, insertedCount: 0, duplicateCount: 0, rejectedCount: 0,
  }
  try {
    if (!Number.isSafeInteger(options.startPage) || options.startPage < 1 ||
      (options.endPage !== undefined && (!Number.isSafeInteger(options.endPage) || options.endPage < options.startPage))) {
      throw new Error('시작 페이지는 1 이상의 정수, 끝 페이지는 시작 페이지 이상의 정수로 입력해주세요.')
    }
    if (siteId !== 'kone-pornvideo-hot' && options.endPage === undefined) {
      throw new Error('끝 페이지를 입력해주세요.')
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab?.id === undefined || !tab.url) throw new Error('수집할 사이트 탭을 찾을 수 없습니다.')
    const start = listUrl(tab.url, siteId)
    const configured = listUrl(options.targetUrl, siteId)
    if (siteId === 'kone-pornvideo-hot'
      ? start.origin !== configured.origin || start.pathname !== configured.pathname
      : start.href !== configured.href) {
      throw new Error('선택한 목록과 현재 탭의 주소·정렬이 다릅니다.')
    }
    const isKiss = siteId === 'kissjav-most-popular-week'
    let url = isKiss ? tab.url : pageUrl(start, options.startPage, siteId).href
    let previousUrl = tab.url
    let previousPage: number | undefined
    let previousDocumentId: string | undefined
    // ponytail: panel owns the loop; closing it stops after the in-flight page is saved.
    while (!signal.aborted) {
      if (!isKiss) progress.page = pageNumber(new URL(url), siteId)
      onProgress({ ...progress })
      let state: PageState | undefined
      let summary: CrawlSummary | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted()
        if (isKiss) {
          state = await kissjavPage(tab.id, start, progress.page, signal, previousPage, previousDocumentId)
          previousPage = state.page
          previousDocumentId = state.documentId
        } else {
          const current = await chrome.tabs.get(tab.id)
          if (
            (!samePageUrl(current.url, previousUrl, siteId) && !samePageUrl(current.url, url, siteId)) ||
            (current.pendingUrl && !samePageUrl(current.pendingUrl, url, siteId))
          ) {
            throw new Error('수집 탭이 다른 페이지로 이동했습니다. 자동 수집을 중단합니다.')
          }
          const [before] = await waitForSnapshot(chrome.scripting.executeScript({
            target: { tabId: tab.id }, func: () => location.href,
          }), 15_000, signal)
          if (!before?.documentId) throw new Error('수집할 페이지 문서를 확인하지 못했습니다.')
          const latest = await chrome.tabs.get(tab.id)
          if ((!samePageUrl(before.result, previousUrl, siteId) && !samePageUrl(before.result, url, siteId)) ||
            !samePageUrl(latest.url, before.result!, siteId) ||
            (latest.pendingUrl && !samePageUrl(latest.pendingUrl, url, siteId))) {
            throw new Error('수집 탭이 다른 페이지로 이동했습니다. 자동 수집을 중단합니다.')
          }
          signal.throwIfAborted()
          if (samePageUrl(before.result, url, siteId)) await chrome.tabs.reload(tab.id)
          else await chrome.tabs.update(tab.id, { url })
          // update() can return before the new document commits.
          const deadline = Date.now() + 5_000
          while (samePageUrl((await chrome.tabs.get(tab.id)).url, previousUrl, siteId) && !samePageUrl(previousUrl, url, siteId)) {
            if (Date.now() >= deadline) throw new Error('페이지 이동에 실패했습니다.')
            await delay(100, signal)
          }
          previousUrl = url
          try {
            state = await waitForPage(tab.id, url, before.documentId, siteId, signal)
          } catch (error) {
            // Retry only while still on this page; never overwrite a user's navigation.
            if (signal.aborted || attempt === 1 || !samePageUrl((await chrome.tabs.get(tab.id)).url, url, siteId)) throw error
            continue
          }
        }
        signal.throwIfAborted()
        const response = await sendRuntimeRequest<CrawlSummary>({
          type: 'CRAWL_ACTIVE_TAB',
          payload: { siteId, targetUrl: options.targetUrl,
            tabId: tab.id, expectedTabUrl: state.url, expectedDocumentId: state.documentId,
            ...(isKiss ? { expectedKissjavPage: progress.page } : {}),
            captureFailurePayload: options.captureFailurePayload },
        })
        if (!response.ok) {
          if (attempt === 0 && ['PARSE_EMPTY', 'PARSE_FAILED', 'CONTENT_SCRIPT_UNAVAILABLE'].includes(response.error.code)) continue
          throw new Error(response.error.message)
        }
        summary = response.data
        break
      }
      if (!state || !summary) throw new Error('페이지 수집 결과를 받지 못했습니다.')
      progress.completedPages++
      progress.insertedCount += summary.insertedCount
      progress.duplicateCount += summary.exactDuplicateCount
      progress.rejectedCount += summary.rejectedCount
      onProgress({ ...progress })
      if (summary.status === 'partial') throw new Error('일부 항목을 저장하지 못해 이 페이지에서 중단했습니다.')
      if (signal.aborted) break
      if (options.endPage !== undefined && progress.page >= options.endPage) {
        return { progress, status: 'success' }
      }
      if (!state.nextUrl) {
        if (progress.page < state.lastPage) throw new Error('다음 페이지 링크를 확인하지 못했습니다.')
        return { progress, status: 'success' }
      }
      if (isKiss) {
        try {
          if (listUrl(state.nextUrl, siteId).href !== start.href) throw new Error()
        } catch { throw new Error('페이지 이동 버튼이 수집 범위를 벗어났습니다.') }
        progress.page++
      }
      else url = nextPageUrl(url, state.nextUrl, siteId)
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
