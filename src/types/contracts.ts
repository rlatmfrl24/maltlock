export type CrawlErrorCode =
  | 'TAB_NOT_FOUND'
  | 'TAB_URL_MISMATCH'
  | 'CONTENT_SCRIPT_UNAVAILABLE'
  | 'PARSE_FAILED'
  | 'PARSE_EMPTY'
  | 'NORMALIZATION_EMPTY'
  | 'PRIVACY_BLUR_FAILED'
  | 'NO_ITEMS'
  | 'INVALID_REQUEST'
  | 'UNKNOWN'

export type CrawlStage =
  | 'validate'
  | 'collect'
  | 'resolve-input'
  | 'parse'
  | 'normalize'
  | 'persist'

export type CrawlInputSource = 'dom-html' | 'api-json' | 'fallback-html'

export type CrawlWarningCode =
  | 'API_FALLBACK_USED'
  | 'PAYLOAD_TOO_LARGE'

export type PageReadyState = 'loading' | 'interactive' | 'complete'

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
  dedupeKey?: string
  identities?: ItemIdentity[]
  previewImageUrl?: string
  summary?: string
  price?: number
  rawHtmlSnippet?: string
}

export interface CrawledItem {
  id: string
  siteId: string
  title: string
  url: string
  previewImageUrl?: string
  summary?: string
  price?: number
  rawHtmlSnippet?: string
  crawledAt: number
  dedupeKey?: string
  identities?: ItemIdentity[]
  normalizedTitle?: string
  contentGroupId?: string
  groupReason?: ItemGroupReason
  groupScore?: number
  similarityExcluded?: boolean
}

export type ItemIdentityKind =
  | 'source-id'
  | 'media-id'
  | 'content-code'
  | 'canonical-url'
  | 'preview'

export interface ItemIdentity {
  kind: ItemIdentityKind
  value: string
  scope: 'site' | 'global'
}

export type ItemGroupReason = 'global-identity' | 'title-exact' | 'title-similar'

export interface ItemSignature {
  id: string
  itemId: string
  siteId: string
  kind: ItemIdentityKind | 'title-exact' | 'title-band'
  scope: 'site' | 'global'
  valueHash: string
  createdAt: number
}

export interface AppMeta {
  key: string
  value: unknown
  updatedAt: number
}

export interface ItemGroup {
  id: string
  representative: CrawledItem
  items: CrawledItem[]
  reason?: ItemGroupReason
  score?: number
}

export interface ItemCountSummary {
  itemCount: number
  groupCount: number
}

export interface CrawledItemLog {
  id: string
  siteId: string
  itemId: string
  firstSeenAt: number
  lastSeenAt: number
  seenCount: number
}

export interface CrawlRun {
  runId: string
  siteId: string
  startedAt: number
  finishedAt: number
  status: 'success' | 'partial' | 'failed'
  /** @deprecated 과거 실행 기록 호환용입니다. */
  itemCount?: number
  errorCode?: CrawlErrorCode
  parserId?: string
  stage?: CrawlStage
  inputSource?: CrawlInputSource
  inputBytes?: number
  inputHash?: string
  parsedCount?: number
  validCount?: number
  insertedCount?: number
  duplicateCount?: number
  exactDuplicateCount?: number
  similarGroupedCount?: number
  uniqueInsertedCount?: number
  rejectedCount?: number
  durationMs?: number
  errorDetail?: string
  warnings?: CrawlWarningCode[]
  tabUrl?: string
  documentTitle?: string
  readyState?: PageReadyState
  bodyTextLength?: number
}

export interface CrawlDiagnosticArtifact {
  runId: string
  siteId: string
  createdAt: number
  inputSource: CrawlInputSource
  mimeType: 'text/html' | 'application/json'
  encoding: 'gzip'
  originalBytes: number
  storedBytes: number
  payload: Uint8Array
}

export interface OpenTargetSitePayload {
  siteId: string
  targetUrl?: string
}

export interface OpenItemLinkPayload {
  url: string
  newTab?: boolean
}

export interface CrawlActiveTabPayload {
  siteId: string
  targetUrl?: string
  captureFailurePayload?: boolean
}

export interface SetPrivacyScreenBlurPayload {
  enabled: boolean
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

export interface OpenItemLinkMessage {
  type: 'OPEN_ITEM_LINK'
  payload: OpenItemLinkPayload
}

export interface CrawlActiveTabMessage {
  type: 'CRAWL_ACTIVE_TAB'
  payload: CrawlActiveTabPayload
}

export interface SetPrivacyScreenBlurMessage {
  type: 'SET_PRIVACY_SCREEN_BLUR'
  payload: SetPrivacyScreenBlurPayload
}

export interface CrawlResultMessage {
  type: 'CRAWL_RESULT'
  payload: CrawlResultPayload
}

export interface CrawlErrorMessage {
  type: 'CRAWL_ERROR'
  payload: CrawlErrorPayload
}

export type RuntimeRequestMessage =
  | OpenTargetSiteMessage
  | OpenItemLinkMessage
  | CrawlActiveTabMessage
  | SetPrivacyScreenBlurMessage
export type RuntimeEventMessage = CrawlResultMessage | CrawlErrorMessage
export type RuntimeMessage = RuntimeRequestMessage | RuntimeEventMessage

export interface OpenTargetSiteResult {
  siteId: string
  tabId: number
  url: string
}

export interface OpenItemLinkResult {
  tabId: number
  url: string
  newTab: boolean
}

export interface CrawlSummary {
  siteId: string
  tabId: number
  tabUrl: string
  parsedCount: number
  validCount: number
  insertedCount: number
  duplicateCount: number
  exactDuplicateCount: number
  similarGroupedCount: number
  uniqueInsertedCount: number
  rejectedCount: number
  status: 'success' | 'partial'
  runId: string
}

export interface SetPrivacyScreenBlurResult {
  enabled: boolean
  appliedTabCount: number
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
  documentTitle: string
  readyState: PageReadyState
  bodyTextLength: number
}

export type SiteParser = (html: string, pageUrl: string) => ParsedItem[]
