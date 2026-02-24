export type CrawlErrorCode =
  | 'TAB_NOT_FOUND'
  | 'TAB_URL_MISMATCH'
  | 'CONTENT_SCRIPT_UNAVAILABLE'
  | 'PARSE_FAILED'
  | 'NO_ITEMS'
  | 'INVALID_REQUEST'
  | 'UNKNOWN'

export interface TargetSite {
  id: string
  name: string
  url: string
  matchPatterns: string[]
  parserId: string
}

export interface ParsedItem {
  title: string
  url: string
  summary?: string
  price?: number
  rawHtmlSnippet?: string
}

export interface CrawledItem {
  id: string
  siteId: string
  title: string
  url: string
  summary?: string
  price?: number
  rawHtmlSnippet?: string
  crawledAt: number
}

export interface CrawlRun {
  runId: string
  siteId: string
  startedAt: number
  finishedAt: number
  status: 'success' | 'partial' | 'failed'
  itemCount: number
  errorCode?: CrawlErrorCode
}

export interface OpenTargetSitePayload {
  siteId: string
}

export interface CrawlActiveTabPayload {
  siteId: string
}

export interface CrawlResultPayload {
  siteId: string
  html: string
  tabUrl: string
}

export interface CrawlErrorPayload {
  siteId: string
  code: CrawlErrorCode
  detail: string
}

export interface OpenTargetSiteMessage {
  type: 'OPEN_TARGET_SITE'
  payload: OpenTargetSitePayload
}

export interface CrawlActiveTabMessage {
  type: 'CRAWL_ACTIVE_TAB'
  payload: CrawlActiveTabPayload
}

export interface CrawlResultMessage {
  type: 'CRAWL_RESULT'
  payload: CrawlResultPayload
}

export interface CrawlErrorMessage {
  type: 'CRAWL_ERROR'
  payload: CrawlErrorPayload
}

export type RuntimeRequestMessage = OpenTargetSiteMessage | CrawlActiveTabMessage
export type RuntimeEventMessage = CrawlResultMessage | CrawlErrorMessage
export type RuntimeMessage = RuntimeRequestMessage | RuntimeEventMessage

export interface OpenTargetSiteResult {
  siteId: string
  tabId: number
  url: string
}

export interface CrawlSummary {
  siteId: string
  tabId: number
  tabUrl: string
  parsedCount: number
  storedCount: number
  status: 'success' | 'partial'
  runId: string
}

export interface RuntimeSuccessResponse<T> {
  ok: true
  data: T
}

export interface RuntimeErrorResponse {
  ok: false
  error: {
    code: CrawlErrorCode
    message: string
    detail?: string
  }
}

export type RuntimeResponse<T> = RuntimeSuccessResponse<T> | RuntimeErrorResponse

export interface CollectHtmlRequest {
  type: 'COLLECT_HTML'
}

export interface CollectHtmlResponse {
  html: string
  tabUrl: string
}

export type SiteParser = (html: string, pageUrl: string) => ParsedItem[]
