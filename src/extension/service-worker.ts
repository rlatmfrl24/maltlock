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
  SetPrivacyScreenBlurMessage,
  SetPrivacyScreenBlurResult,
  RuntimeRequestMessage,
  RuntimeResponse,
} from '../types/contracts'

const PRIVACY_BLUR_STYLE_ID = 'maltlock-privacy-screen-blur-style'
let privacyScreenBlurEnabled = false
const privacyBlurredTabIds = new Set<number>()

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

function normalizeTargetUrl(input: string | undefined): string | undefined {
  if (!input) {
    return undefined
  }

  const trimmed = input.trim()
  if (!trimmed) {
    return undefined
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined
    }
    return parsed.toString()
  } catch {
    return undefined
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

    const targetUrl = normalizeTargetUrl(message.payload.targetUrl)
    if (message.payload.targetUrl && !targetUrl) {
      return errorResponse(
        new CrawlFailure('INVALID_REQUEST', '사이트 URL 형식이 올바르지 않습니다.'),
      )
    }

    const tab = await chrome.tabs.create({
      url: targetUrl ?? site.url,
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
        url: targetUrl ?? site.url,
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
    const targetUrl = normalizeTargetUrl(message.payload.targetUrl)

    if (!site) {
      throw new CrawlFailure('INVALID_REQUEST', '알 수 없는 사이트 ID입니다.')
    }

    if (message.payload.targetUrl && !targetUrl) {
      throw new CrawlFailure('INVALID_REQUEST', '사이트 URL 형식이 올바르지 않습니다.')
    }

    const activeTab = await getActiveTab()

    if (!siteMatchesUrl(site, activeTab.url, targetUrl)) {
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
      if (import.meta.env.DEV) {
        console.info('[maltlock] parse result', {
          parserId: site.parserId,
          tabUrl: collected.tabUrl,
          parsedCount: parsedItems.length,
          htmlLength: collected.html.length,
        })
      }
    } catch (error) {
      throw new CrawlFailure(
        'PARSE_FAILED',
        'HTML 파싱 중 오류가 발생했습니다.',
        error instanceof Error ? error.message : undefined,
      )
    }

    const upserted = await upsertCrawledItems(site.id, parsedItems, Date.now())

    const status = upserted.insertedCount === 0 ? 'partial' : 'success'

    crawlRun.status = status
    crawlRun.itemCount = upserted.insertedCount
    crawlRun.errorCode = upserted.insertedCount === 0 ? 'NO_ITEMS' : undefined

    return {
      ok: true,
      data: {
        siteId,
        tabId: activeTab.id,
        tabUrl: collected.tabUrl,
        parsedCount: parsedItems.length,
        storedCount: upserted.insertedCount,
        updatedCount: upserted.updatedCount,
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

async function setPrivacyBlurInTab(
  tabId: number,
  enabled: boolean,
): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (styleId: string, shouldEnable: boolean) => {
        const existing = document.getElementById(styleId)

        if (!shouldEnable) {
          existing?.remove()
          return
        }

        if (existing) {
          return
        }

        const style = document.createElement('style')
        style.id = styleId
        style.textContent = `
          html {
            filter: blur(14px) brightness(0.7) !important;
            transition: filter 120ms ease-in-out !important;
          }
        `
        ;(document.head ?? document.documentElement).appendChild(style)
      },
      args: [PRIVACY_BLUR_STYLE_ID, enabled],
    })

    return true
  } catch {
    return false
  }
}

async function setPrivacyScreenBlur(
  message: SetPrivacyScreenBlurMessage,
): Promise<RuntimeResponse<SetPrivacyScreenBlurResult>> {
  const { enabled } = message.payload
  privacyScreenBlurEnabled = enabled

  if (enabled) {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    })
    let appliedTabCount = 0

    for (const tab of tabs) {
      if (tab.id === undefined) {
        continue
      }

      // Ignore tabs where script execution is unavailable (e.g. chrome://).
      if (await setPrivacyBlurInTab(tab.id, true)) {
        privacyBlurredTabIds.add(tab.id)
        appliedTabCount += 1
      }
    }

    return {
      ok: true,
      data: {
        enabled: true,
        appliedTabCount,
      },
    }
  }

  let appliedTabCount = 0
  for (const tabId of [...privacyBlurredTabIds]) {
    if (await setPrivacyBlurInTab(tabId, false)) {
      appliedTabCount += 1
    }
  }
  privacyBlurredTabIds.clear()

  return {
    ok: true,
    data: {
      enabled: false,
      appliedTabCount,
    },
  }
}

function isRuntimeRequestMessage(message: unknown): message is RuntimeRequestMessage {
  if (!message || typeof message !== 'object') {
    return false
  }

  const maybeMessage = message as { type?: string }
  return (
    maybeMessage.type === 'OPEN_TARGET_SITE' ||
    maybeMessage.type === 'CRAWL_ACTIVE_TAB' ||
    maybeMessage.type === 'SET_PRIVACY_SCREEN_BLUR'
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

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!privacyScreenBlurEnabled) {
    return
  }

  void setPrivacyBlurInTab(tabId, true).then((applied) => {
    if (applied) {
      privacyBlurredTabIds.add(tabId)
    }
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!privacyScreenBlurEnabled || changeInfo.status !== 'complete') {
    return
  }

  void setPrivacyBlurInTab(tabId, true).then((applied) => {
    if (applied) {
      privacyBlurredTabIds.add(tabId)
    }
  })
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

  if (message.type === 'SET_PRIVACY_SCREEN_BLUR') {
    void setPrivacyScreenBlur(message).then(sendResponse)
    return true
  }

  sendResponse(
    errorResponse(
      new CrawlFailure('INVALID_REQUEST', '지원하지 않는 메시지 타입입니다.'),
    ),
  )
  return false
})
