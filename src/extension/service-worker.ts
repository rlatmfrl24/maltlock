import { getTargetSiteById, siteMatchesUrl } from '../config/targets'
import { saveCrawlRun, upsertCrawledItems } from '../db/repository'
import { parseByParserId } from '../parsers'
import type {
  CollectHtmlRequest,
  CollectHtmlResponse,
  CrawlActiveTabMessage,
  CrawlErrorCode,
  CrawlRun,
  CrawlSummary,
  OpenTargetSiteMessage,
  RuntimeRequestMessage,
  RuntimeResponse,
} from '../types/contracts'

class CrawlFailure extends Error {
  code: CrawlErrorCode
  detail?: string

  constructor(code: CrawlErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'CrawlFailure'
    this.code = code
    this.detail = detail
  }
}

function toCrawlFailure(error: unknown): CrawlFailure {
  if (error instanceof CrawlFailure) {
    return error
  }

  if (error instanceof Error) {
    return new CrawlFailure('UNKNOWN', error.message)
  }

  return new CrawlFailure('UNKNOWN', '알 수 없는 오류가 발생했습니다.')
}

function errorResponse<T>(error: CrawlFailure): RuntimeResponse<T> {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      detail: error.detail,
    },
  }
}

async function ensureSidePanelBehavior(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true,
    })
  } catch {
    // Side panel capability may vary by Chrome version.
  }
}

async function openTargetSite(
  message: OpenTargetSiteMessage,
): Promise<RuntimeResponse<{ siteId: string; tabId: number; url: string }>> {
  try {
    const site = getTargetSiteById(message.payload.siteId)

    if (!site) {
      return errorResponse(
        new CrawlFailure('INVALID_REQUEST', '알 수 없는 사이트 ID입니다.'),
      )
    }

    const tab = await chrome.tabs.create({
      url: site.url,
      active: true,
    })

    if (!tab.id) {
      return errorResponse(
        new CrawlFailure('TAB_NOT_FOUND', '새 탭을 생성할 수 없습니다.'),
      )
    }

    return {
      ok: true,
      data: {
        siteId: site.id,
        tabId: tab.id,
        url: site.url,
      },
    }
  } catch (error) {
    return errorResponse(toCrawlFailure(error))
  }
}

interface ActiveTab {
  id: number
  url: string
}

async function getActiveTab(): Promise<ActiveTab> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  })

  if (!tab || tab.id === undefined || !tab.url) {
    throw new CrawlFailure('TAB_NOT_FOUND', '활성 탭을 찾을 수 없습니다.')
  }

  return { id: tab.id, url: tab.url }
}

async function collectHtmlFromTab(tabId: number): Promise<CollectHtmlResponse> {
  const request: CollectHtmlRequest = { type: 'COLLECT_HTML' }

  try {
    const response = (await chrome.tabs.sendMessage(tabId, request)) as
      | CollectHtmlResponse
      | undefined

    if (response?.html) {
      return response
    }
  } catch {
    // Falls through to script execution fallback.
  }

  const executionResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      html: document.documentElement.outerHTML,
      tabUrl: window.location.href,
    }),
  })

  const result = executionResults[0]?.result

  if (!result?.html || !result.tabUrl) {
    throw new CrawlFailure(
      'CONTENT_SCRIPT_UNAVAILABLE',
      '활성 탭 HTML 수집에 실패했습니다.',
    )
  }

  return {
    html: result.html,
    tabUrl: result.tabUrl,
  }
}

async function crawlActiveTab(
  message: CrawlActiveTabMessage,
): Promise<RuntimeResponse<CrawlSummary>> {
  const siteId = message.payload.siteId
  const runId = crypto.randomUUID()
  const startedAt = Date.now()

  const crawlRun: CrawlRun = {
    runId,
    siteId,
    startedAt,
    finishedAt: startedAt,
    status: 'failed',
    itemCount: 0,
    errorCode: undefined,
  }

  try {
    const site = getTargetSiteById(siteId)

    if (!site) {
      throw new CrawlFailure('INVALID_REQUEST', '알 수 없는 사이트 ID입니다.')
    }

    const activeTab = await getActiveTab()

    if (!siteMatchesUrl(site, activeTab.url)) {
      throw new CrawlFailure(
        'TAB_URL_MISMATCH',
        '활성 탭 URL이 선택한 사이트와 일치하지 않습니다.',
        activeTab.url,
      )
    }

    const collected = await collectHtmlFromTab(activeTab.id)

    let parsedItems
    try {
      parsedItems = parseByParserId(site.parserId, collected.html, collected.tabUrl)
    } catch (error) {
      throw new CrawlFailure(
        'PARSE_FAILED',
        'HTML 파싱 중 오류가 발생했습니다.',
        error instanceof Error ? error.message : undefined,
      )
    }

    const storedItems = await upsertCrawledItems(site.id, parsedItems, Date.now())

    const status = storedItems.length === 0 ? 'partial' : 'success'

    crawlRun.status = status
    crawlRun.itemCount = storedItems.length
    crawlRun.errorCode = storedItems.length === 0 ? 'NO_ITEMS' : undefined

    return {
      ok: true,
      data: {
        siteId,
        tabId: activeTab.id,
        tabUrl: collected.tabUrl,
        parsedCount: parsedItems.length,
        storedCount: storedItems.length,
        status,
        runId,
      },
    }
  } catch (error) {
    const failure = toCrawlFailure(error)
    crawlRun.status = 'failed'
    crawlRun.errorCode = failure.code

    return errorResponse(failure)
  } finally {
    crawlRun.finishedAt = Date.now()
    await saveCrawlRun(crawlRun)
  }
}

function isRuntimeRequestMessage(message: unknown): message is RuntimeRequestMessage {
  if (!message || typeof message !== 'object') {
    return false
  }

  const maybeMessage = message as { type?: string }
  return (
    maybeMessage.type === 'OPEN_TARGET_SITE' ||
    maybeMessage.type === 'CRAWL_ACTIVE_TAB'
  )
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureSidePanelBehavior()
})

chrome.runtime.onStartup.addListener(() => {
  void ensureSidePanelBehavior()
})

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) {
    return
  }

  void chrome.sidePanel.open({ tabId: tab.id })
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeRequestMessage(message)) {
    sendResponse(
      errorResponse(
        new CrawlFailure('INVALID_REQUEST', '지원하지 않는 메시지 타입입니다.'),
      ),
    )
    return false
  }

  if (message.type === 'OPEN_TARGET_SITE') {
    void openTargetSite(message).then(sendResponse)
    return true
  }

  if (message.type === 'CRAWL_ACTIVE_TAB') {
    void crawlActiveTab(message).then(sendResponse)
    return true
  }

  sendResponse(
    errorResponse(
      new CrawlFailure('INVALID_REQUEST', '지원하지 않는 메시지 타입입니다.'),
    ),
  )
  return false
})
