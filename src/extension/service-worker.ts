import { getTargetSiteById, normalizeKissjavUrl, siteMatchesUrl } from '../config/targets'
import {
  saveCrawlDiagnostic,
  saveCrawlRun,
  upsertCrawledItems,
} from '../db/repository'
import { buildNimiApiUrl } from './nimi'
import { isEmptyNimiApiPayload } from '../parsers/nimi-tw-ranking.parser'
import { collectHtml } from './collect-html'
import { delay, waitForSnapshot } from './auto-crawl'
import { parseByParserId } from '../parsers'
import type {
  CollectHtmlRequest,
  CollectHtmlResponse,
  CrawlActiveTabMessage,
  CrawlErrorCode,
  CrawlInputSource,
  CrawlRun,
  CrawlSummary,
  CrawlWarningCode,
  OpenItemLinkMessage,
  OpenItemLinkResult,
  OpenTargetSiteMessage,
  OpenTargetSiteResult,
  SetPrivacyScreenBlurMessage,
  SetPrivacyScreenBlurResult,
  RuntimeRequestMessage,
  RuntimeResponse,
} from '../types/contracts'
import {
  classifyCrawlOutcome,
  clipErrorDetail,
  isParserFailureRun,
  setCrawlStage,
} from './crawl-diagnostics'
import {
  createDiagnosticArtifact,
  createInputHash,
  DIAGNOSTIC_RETENTION_MS,
  getInputByteLength,
  MAX_DIAGNOSTICS_PER_SITE,
} from './diagnostic-artifacts'

const PRIVACY_BLUR_STYLE_ID = 'maltlock-privacy-screen-blur-style'
let privacyScreenBlurEnabled = false
const privacyBlurredTabIds = new Set<number>()
const targetPreparations = new Map<string, AbortController>()

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

async function fetchNimiApiPayload(
  collected: CollectHtmlResponse,
): Promise<string | undefined> {
  const apiUrl = buildNimiApiUrl(collected.html, collected.tabUrl)

  if (!apiUrl) {
    return undefined
  }

  const response = await fetch(apiUrl, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`NimiWiki API 요청에 실패했습니다. (HTTP ${response.status})`)
  }

  const payload = (await response.text()).trim()

  if (!payload.startsWith('{') && !payload.startsWith('[')) {
    throw new Error('NimiWiki API에서 JSON 목록을 받지 못했습니다.')
  }

  return payload
}

interface ResolvedParserInput {
  content: string
  source: CrawlInputSource
  warnings: CrawlWarningCode[]
}

async function resolveParserInput(
  parserId: string,
  collected: CollectHtmlResponse,
): Promise<ResolvedParserInput> {
  if (parserId !== 'nimi-tw-ranking') {
    return {
      content: collected.html,
      source: 'dom-html',
      warnings: [],
    }
  }

  try {
    const nimiApiPayload = await fetchNimiApiPayload(collected)

    if (nimiApiPayload) {
      return {
        content: nimiApiPayload,
        source: 'api-json',
        warnings: [],
      }
    }
  } catch (error) {
    const apiError = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      ? 'NimiWiki API가 15초 안에 응답하지 않았습니다.'
      : error instanceof Error ? error.message : String(error)
    if (import.meta.env.DEV) {
      console.warn('[maltlock] failed to fetch nimi api payload', {
        tabUrl: collected.tabUrl,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    throw new CrawlFailure('PARSE_FAILED', apiError)
  }

  return {
    content: collected.html,
    source: 'fallback-html',
    warnings: ['API_FALLBACK_USED'],
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
): Promise<RuntimeResponse<OpenTargetSiteResult>> {
  const requestId = message.payload?.requestId
  const controller = new AbortController()
  if (requestId !== undefined) {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 64 || targetPreparations.has(requestId)) {
      return errorResponse(new CrawlFailure('INVALID_REQUEST', '사이트 준비 요청 ID가 올바르지 않습니다.'))
    }
    targetPreparations.set(requestId, controller)
  }
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

    const requestedUrl = targetUrl ?? site.url
    const nextUrl = site.id === 'kissjav-most-popular-week' && siteMatchesUrl(site, requestedUrl)
      ? normalizeKissjavUrl(requestedUrl).href : requestedUrl
    const activeTab = await getActiveTab()
    const deadline = Date.now() + 15_000
    const signal = controller.signal
    const snapshot = () => waitForSnapshot(chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => ({ url: location.href, ready: document.readyState === 'complete' }),
    }), deadline - Date.now(), signal)
    // A same-URL navigation must replace the old document before capture.
    const before = activeTab.url === nextUrl ? (await snapshot())[0] : undefined
    if (activeTab.url === nextUrl && !before?.documentId) {
      throw new CrawlFailure('CONTENT_SCRIPT_UNAVAILABLE', '사이트 이동 전에 현재 페이지의 문서를 확인하지 못했습니다.')
    }
    const current = await chrome.tabs.get(activeTab.id)
    if (current.url !== activeTab.url || (current.pendingUrl && current.pendingUrl !== activeTab.url)) {
      throw new CrawlFailure('TAB_URL_MISMATCH', '사이트 이동 전에 현재 탭이 변경되었습니다.')
    }
    if (before && (!before.documentId || before.result?.url !== activeTab.url)) {
      throw new CrawlFailure('TAB_URL_MISMATCH', '사이트 이동 전에 페이지 문서가 변경되었습니다.')
    }
    signal.throwIfAborted()
    await chrome.tabs.update(activeTab.id, {
      url: nextUrl,
      active: true,
    })
    let committed = false
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      const loading = await chrome.tabs.get(activeTab.id)
      if ((loading.url !== nextUrl && (committed || loading.url !== activeTab.url)) ||
        (loading.pendingUrl && loading.pendingUrl !== nextUrl)) {
        throw new CrawlFailure('TAB_URL_MISMATCH', '수집 탭이 다른 페이지로 이동했습니다. 크롤링을 중단합니다.')
      }
      if (loading.url === nextUrl) committed = true
      if (loading.url === nextUrl && loading.status === 'complete' && !loading.pendingUrl) {
        const [document] = await snapshot()
        if (document?.result?.url !== nextUrl) {
          throw new CrawlFailure('TAB_URL_MISMATCH', '수집 중 대상 페이지가 변경되었습니다.')
        }
        const latest = await chrome.tabs.get(activeTab.id)
        if (latest.url !== nextUrl || (latest.pendingUrl && latest.pendingUrl !== nextUrl)) {
          throw new CrawlFailure('TAB_URL_MISMATCH', '수집 중 대상 페이지가 변경되었습니다.')
        }
        if (document.documentId && document.documentId !== before?.documentId && document.result.ready) {
          signal.throwIfAborted()
          return { ok: true, data: { siteId: site.id, tabId: activeTab.id, url: nextUrl, documentId: document.documentId } }
        }
      }
      await delay(Math.min(150, Math.max(1, deadline - Date.now())), signal)
    }
    throw new CrawlFailure('CONTENT_SCRIPT_UNAVAILABLE', '15초 안에 사이트의 새 문서를 확인하지 못했습니다. 사이트 화면의 로그인·접속 오류를 확인해주세요.')
  } catch (error) {
    if (error instanceof Error && error.message.includes('페이지 문서 응답 시간이 초과')) {
      return errorResponse(new CrawlFailure('CONTENT_SCRIPT_UNAVAILABLE', error.message))
    }
    return errorResponse(toCrawlFailure(error))
  } finally {
    if (requestId) targetPreparations.delete(requestId)
  }
}

async function openItemLink(
  message: OpenItemLinkMessage,
): Promise<RuntimeResponse<OpenItemLinkResult>> {
  const targetUrl = normalizeTargetUrl(message.payload.url)

  if (!targetUrl) {
    return errorResponse(
      new CrawlFailure('INVALID_REQUEST', '아이템 URL 형식이 올바르지 않습니다.'),
    )
  }

  try {
    if (message.payload.newTab) {
      const tab = await chrome.tabs.create({
        url: targetUrl,
        active: false,
      })

      if (tab.id === undefined) {
        return errorResponse(
          new CrawlFailure('TAB_NOT_FOUND', '새 탭을 열 수 없습니다.'),
        )
      }

      return {
        ok: true,
        data: {
          tabId: tab.id,
          url: targetUrl,
          newTab: true,
        },
      }
    }

    const activeTab = await getActiveTab()
    const tab = await chrome.tabs.update(activeTab.id, {
      url: targetUrl,
      active: true,
    })
    const updatedTabId = tab?.id ?? activeTab.id

    if (!updatedTabId) {
      return errorResponse(
        new CrawlFailure('TAB_NOT_FOUND', '현재 탭에서 링크를 열 수 없습니다.'),
      )
    }

    return {
      ok: true,
      data: {
        tabId: updatedTabId,
        url: targetUrl,
        newTab: false,
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

async function collectHtmlFromTab(tabId: number, documentId?: string): Promise<CollectHtmlResponse> {
  const request: CollectHtmlRequest = { type: 'COLLECT_HTML' }

  try {
    const response = (await chrome.tabs.sendMessage(tabId, request, documentId ? { documentId } : {})) as
      | CollectHtmlResponse
      | undefined

    if (response?.html) {
      return response
    }
  } catch {
    // Falls through to script execution fallback.
  }

  const executionResults = await chrome.scripting.executeScript({
    target: { tabId, ...(documentId ? { documentIds: [documentId] } : {}) },
    func: collectHtml,
  })

  const result = executionResults[0]?.result

  if (!result?.html || !result.tabUrl) {
    throw new CrawlFailure(
      'CONTENT_SCRIPT_UNAVAILABLE',
      '활성 탭 HTML 수집에 실패했습니다.',
    )
  }

  return result
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
    errorCode: undefined,
    stage: 'validate',
  }
  let parserInput: ResolvedParserInput | undefined

  try {
    const site = getTargetSiteById(siteId)
    const targetUrl = normalizeTargetUrl(message.payload.targetUrl)

    if (!site) {
      throw new CrawlFailure('INVALID_REQUEST', '알 수 없는 사이트 ID입니다.')
    }

    crawlRun.parserId = site.parserId

    if (message.payload.targetUrl && !targetUrl) {
      throw new CrawlFailure('INVALID_REQUEST', '사이트 URL 형식이 올바르지 않습니다.')
    }

    const requestedTabId = message.payload.tabId
    if (requestedTabId !== undefined && !Number.isInteger(requestedTabId)) {
      throw new CrawlFailure('INVALID_REQUEST', '탭 ID 형식이 올바르지 않습니다.')
    }
    const tab = requestedTabId === undefined
      ? await getActiveTab()
      : await chrome.tabs.get(requestedTabId)
    if (tab.id === undefined || !tab.url) {
      throw new CrawlFailure('TAB_NOT_FOUND', '수집할 탭을 찾을 수 없습니다.')
    }
    const activeTab = { id: tab.id, url: tab.url }

    if (!siteMatchesUrl(site, activeTab.url, targetUrl)) {
      throw new CrawlFailure(
        'TAB_URL_MISMATCH',
        '활성 탭 URL이 선택한 사이트와 일치하지 않습니다.',
        activeTab.url,
      )
    }

    setCrawlStage(crawlRun, 'collect')
    const collected = await collectHtmlFromTab(activeTab.id, message.payload.expectedDocumentId)
    // Recheck the captured document: navigation can occur after tabs.get().
    if (
      !siteMatchesUrl(site, collected.tabUrl, targetUrl) ||
      (message.payload.expectedTabUrl &&
        collected.tabUrl !== message.payload.expectedTabUrl) ||
      (message.payload.expectedKissjavPage !== undefined &&
        (siteId !== 'kissjav-most-popular-week' || !Number.isSafeInteger(message.payload.expectedKissjavPage) ||
          message.payload.expectedKissjavPage < 1 || !collected.kissjavReady ||
          collected.kissjavPage !== message.payload.expectedKissjavPage))
    ) {
      throw new CrawlFailure('TAB_URL_MISMATCH', '수집 중 대상 페이지가 변경되었습니다.')
    }
    crawlRun.tabUrl = collected.tabUrl
    crawlRun.documentTitle = collected.documentTitle
    crawlRun.readyState = collected.readyState
    crawlRun.bodyTextLength = collected.bodyTextLength

    setCrawlStage(crawlRun, 'resolve-input')
    parserInput = await resolveParserInput(site.parserId, collected)
    crawlRun.inputSource = parserInput.source
    crawlRun.inputBytes = getInputByteLength(parserInput.content)
    crawlRun.inputHash = await createInputHash(parserInput.content)
    crawlRun.warnings = [...parserInput.warnings]

    let parsedItems
    setCrawlStage(crawlRun, 'parse')
    try {
      parsedItems = parseByParserId(site.parserId, parserInput.content, collected.tabUrl)
      if (import.meta.env.DEV) {
        console.info('[maltlock] parse result', {
          parserId: site.parserId,
          tabUrl: collected.tabUrl,
          parsedCount: parsedItems.length,
          htmlLength: parserInput.content.length,
        })
      }
    } catch (error) {
      crawlRun.parsedCount = 0
      throw new CrawlFailure(
        'PARSE_FAILED',
        'HTML 파싱 중 오류가 발생했습니다.',
        error instanceof Error ? error.message : undefined,
      )
    }

    crawlRun.parsedCount = parsedItems.length
    const emptyNimiList = site.parserId === 'nimi-tw-ranking' && parserInput.source === 'api-json' && isEmptyNimiApiPayload(parserInput.content)
    if (parsedItems.length === 0 && !emptyNimiList) {
      crawlRun.validCount = 0
      crawlRun.insertedCount = 0
      crawlRun.duplicateCount = 0
      crawlRun.rejectedCount = 0
      const outcome = classifyCrawlOutcome({
        parsedCount: 0,
        validCount: 0,
        rejectedCount: 0,
      })
      crawlRun.status = outcome.status
      crawlRun.errorCode = outcome.errorCode
      throw new CrawlFailure(
        'PARSE_EMPTY',
        '파서가 수집 가능한 아이템을 찾지 못했습니다.',
      )
    }

    setCrawlStage(crawlRun, 'persist')
    const upserted = await upsertCrawledItems(site.id, parsedItems, Date.now())
    crawlRun.validCount = upserted.validCount
    crawlRun.insertedCount = upserted.insertedCount
    crawlRun.duplicateCount = upserted.duplicateCount
    crawlRun.exactDuplicateCount = upserted.exactDuplicateCount
    crawlRun.rejectedCount = upserted.rejectedCount

    setCrawlStage(crawlRun, 'normalize')
    const outcome = emptyNimiList ? { status: 'success' as const, errorCode: undefined } : classifyCrawlOutcome({
      parsedCount: parsedItems.length,
      validCount: upserted.validCount,
      rejectedCount: upserted.rejectedCount,
    })
    crawlRun.status = outcome.status
    crawlRun.errorCode = outcome.errorCode

    if (outcome.errorCode === 'NORMALIZATION_EMPTY') {
      throw new CrawlFailure(
        'NORMALIZATION_EMPTY',
        '파싱 결과가 모두 유효성 검사에서 제외되었습니다.',
      )
    }

    if (outcome.status === 'failed') {
      throw new CrawlFailure('UNKNOWN', '크롤 실행 결과를 분류하지 못했습니다.')
    }

    setCrawlStage(crawlRun, 'persist')

    return {
      ok: true,
      data: {
        siteId,
        tabId: activeTab.id,
        tabUrl: collected.tabUrl,
        parsedCount: parsedItems.length,
        validCount: upserted.validCount,
        insertedCount: upserted.insertedCount,
        duplicateCount: upserted.duplicateCount,
        exactDuplicateCount: upserted.exactDuplicateCount,
        rejectedCount: upserted.rejectedCount,
        status: outcome.status,
        runId,
      },
    }
  } catch (error) {
    const failure = toCrawlFailure(error)
    crawlRun.status = 'failed'
    crawlRun.errorCode = failure.code
    crawlRun.errorDetail = clipErrorDetail(failure.detail ?? failure.message)

    return errorResponse(failure)
  } finally {
    crawlRun.finishedAt = Date.now()
    crawlRun.durationMs = crawlRun.finishedAt - crawlRun.startedAt

    if (
      message.payload.captureFailurePayload &&
      parserInput &&
      crawlRun.inputSource &&
      isParserFailureRun(crawlRun)
    ) {
      try {
        const diagnostic = await createDiagnosticArtifact({
          runId,
          siteId,
          createdAt: crawlRun.finishedAt,
          inputSource: crawlRun.inputSource,
          content: parserInput.content,
        })

        if (diagnostic.warning) {
          crawlRun.warnings = Array.from(
            new Set([...(crawlRun.warnings ?? []), diagnostic.warning]),
          )
        }

        if (diagnostic.artifact) {
          await saveCrawlDiagnostic(diagnostic.artifact, {
            maxPerSite: MAX_DIAGNOSTICS_PER_SITE,
            maxAgeMs: DIAGNOSTIC_RETENTION_MS,
          })
        }
      } catch (error) {
        console.error('[maltlock] failed to save crawl diagnostic', error)
      }
    }

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
    maybeMessage.type === 'CANCEL_TARGET_SITE' ||
    maybeMessage.type === 'OPEN_ITEM_LINK' ||
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

  if (message.type === 'CANCEL_TARGET_SITE') {
    const requestId = message.payload?.requestId
    if (typeof requestId !== 'string' || !requestId || requestId.length > 64) {
      sendResponse(errorResponse(new CrawlFailure('INVALID_REQUEST', '사이트 준비 요청 ID가 올바르지 않습니다.')))
      return false
    }
    const preparation = targetPreparations.get(requestId)
    preparation?.abort()
    sendResponse({ ok: true, data: { cancelled: !!preparation } })
    return false
  }

  if (message.type === 'OPEN_ITEM_LINK') {
    void openItemLink(message).then(sendResponse)
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
