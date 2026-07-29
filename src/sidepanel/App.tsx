import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { targetSites } from '../config/targets'
import {
  deleteCrawledItem,
  excludeItemFromSimilarityGroup,
  getCrawlDiagnostic,
  getItemBackfillProgress,
  listItemCountSummariesBySite,
  listItemGroupsBySite,
  listCrawlRunsBySite,
  runItemSignatureBackfillBatch,
} from '../db/repository'
import { sendRuntimeRequest } from '../extension/runtime-client'
import { hasConsecutiveParserFailures } from '../extension/crawl-diagnostics'
import { decompressDiagnosticPayload } from '../extension/diagnostic-artifacts'
import { createCrawlDiagnosticExport } from './diagnostic-export'
import { CachedThumbnail } from './CachedThumbnail'
import { removePersistentThumbnail } from './thumbnail-cache'
import {
  DEFAULT_DIAGNOSTIC_CAPTURE_ENABLED,
  DIAGNOSTIC_CAPTURE_STORAGE_KEY,
  readDiagnosticCaptureSetting,
} from './diagnostic-settings'
import type {
  CrawledItem,
  ItemCountSummary,
  ItemGroupReason,
  CrawlRun,
  CrawlErrorCode,
  CrawlSummary,
  OpenTargetSiteResult,
  OpenItemLinkResult,
  SetPrivacyScreenBlurResult,
} from '../types/contracts'

type StatusKind = 'idle' | 'loading' | 'success' | 'warning' | 'error'

interface StatusState {
  kind: StatusKind
  message: string
}

const DEFAULT_STATUS: StatusState = {
  kind: 'idle',
  message: '대상 사이트로 현재 탭을 이동한 뒤 크롤 버튼을 눌러주세요.',
}

const PRIVACY_MODE_STORAGE_KEY = 'maltlock:privacy-mode'
const SITE_URL_STORAGE_KEY = 'maltlock:site-urls'
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'short',
  timeStyle: 'medium',
})
const TARGET_SITE_BY_ID = new Map(targetSites.map((site) => [site.id, site]))
const EMPTY_COUNTS_BY_SITE: Record<string, ItemCountSummary> = Object.fromEntries(
  targetSites.map((site) => [site.id, { itemCount: 0, groupCount: 0 }]),
)
const STATUS_LABEL_BY_KIND: Record<StatusKind, string> = {
  idle: '안내',
  loading: '진행 중',
  success: '완료',
  warning: '주의',
  error: '오류',
}

function getInitialPrivacyMode(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return window.localStorage.getItem(PRIVACY_MODE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function getInitialSiteUrls(): Record<string, string> {
  const defaults = Object.fromEntries(targetSites.map((site) => [site.id, site.url]))

  if (typeof window === 'undefined') {
    return defaults
  }

  try {
    const raw = window.localStorage.getItem(SITE_URL_STORAGE_KEY)
    if (!raw) {
      return defaults
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>
    const merged = { ...defaults }

    for (const site of targetSites) {
      const value = parsed[site.id]
      if (typeof value !== 'string') {
        continue
      }

      const trimmed = value.trim()
      if (!trimmed) {
        continue
      }

      merged[site.id] = trimmed
    }

    return merged
  } catch {
    return defaults
  }
}

function formatDateTime(timestamp: number): string {
  return DATE_TIME_FORMATTER.format(new Date(timestamp))
}

function mapError(code: CrawlErrorCode): string {
  switch (code) {
    case 'TAB_NOT_FOUND':
      return '활성 탭을 찾지 못했습니다. 탭을 선택한 뒤 다시 시도하세요.'
    case 'TAB_URL_MISMATCH':
      return '선택한 사이트와 현재 탭 URL이 다릅니다. 먼저 사이트를 열어주세요.'
    case 'CONTENT_SCRIPT_UNAVAILABLE':
      return 'HTML 수집에 실패했습니다. 페이지를 새로고침 후 다시 시도하세요.'
    case 'PARSE_FAILED':
      return '페이지 구조를 파싱하지 못했습니다. 사이트 구조 변경 여부를 확인하세요.'
    case 'PARSE_EMPTY':
      return '파서가 수집 가능한 아이템을 찾지 못했습니다.'
    case 'NORMALIZATION_EMPTY':
      return '파싱 결과가 모두 유효성 검사에서 제외되었습니다.'
    case 'PRIVACY_BLUR_FAILED':
      return '브라우저 화면 흐림 처리에 실패했습니다.'
    case 'NO_ITEMS':
      return '수집 가능한 아이템이 없습니다.'
    case 'INVALID_REQUEST':
      return '요청 형식이 올바르지 않습니다.'
    default:
      return '알 수 없는 오류가 발생했습니다.'
  }
}

function getTitleLinkUrl(item: CrawledItem): string {
  if (
    (item.siteId === 'twidouga-ranking-t1' ||
      item.siteId === 'nimi-tw-ranking') &&
    item.summary &&
    /^https?:\/\//i.test(item.summary)
  ) {
    return item.summary
  }

  return item.url
}

function getRunStatusLabel(run: CrawlRun): string {
  if (run.status === 'success') {
    return '성공'
  }
  if (run.status === 'partial') {
    return '부분 성공'
  }
  return '실패'
}

function getRunMetrics(run: CrawlRun): string {
  if (run.parsedCount === undefined) {
    return `기존 기록 · ${run.itemCount ?? 0}건`
  }

  return [
    `파싱 ${run.parsedCount}`,
    `유효 ${run.validCount ?? 0}`,
    `신규 ${run.insertedCount ?? 0}`,
    `정확 중복 ${run.exactDuplicateCount ?? run.duplicateCount ?? 0}`,
    `유사 그룹 ${run.similarGroupedCount ?? 0}`,
    `고유 신규 ${run.uniqueInsertedCount ?? run.insertedCount ?? 0}`,
    `탈락 ${run.rejectedCount ?? 0}`,
  ].join(' · ')
}

function getGroupReasonLabel(reason: ItemGroupReason | undefined): string {
  switch (reason) {
    case 'global-identity':
      return '전역 식별자 일치'
    case 'title-exact':
      return '정규화 제목 일치'
    case 'title-similar':
      return '제목 유사'
    default:
      return '개별 항목'
  }
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function shouldOpenItemInNewTab(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.ctrlKey || event.metaKey
}

function App() {
  const defaultSiteId = targetSites[0]?.id ?? ''
  const [activeSiteId, setActiveSiteId] = useState(defaultSiteId)
  const [siteUrls, setSiteUrls] = useState<Record<string, string>>(getInitialSiteUrls)
  const [status, setStatus] = useState<StatusState>(DEFAULT_STATUS)
  const [isCrawling, setIsCrawling] = useState(false)
  const [isPrivacyMode, setIsPrivacyMode] = useState(getInitialPrivacyMode)
  const [isTogglingPrivacyMode, setIsTogglingPrivacyMode] = useState(false)
  const [isListExpanded, setIsListExpanded] = useState(false)
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null)
  const [separatingItemId, setSeparatingItemId] = useState<string | null>(null)
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set())
  const [captureFailurePayload, setCaptureFailurePayload] = useState(
    DEFAULT_DIAGNOSTIC_CAPTURE_ENABLED,
  )
  const [exportingRunId, setExportingRunId] = useState<string | null>(null)
  const initialPrivacyModeRef = useRef(isPrivacyMode)

  const activeSite = useMemo(() => TARGET_SITE_BY_ID.get(activeSiteId), [activeSiteId])
  const activeSiteName = activeSite?.name ?? '-'

  const activeSiteUrl = useMemo(() => {
    if (!activeSite) {
      return ''
    }

    return siteUrls[activeSite.id] ?? activeSite.url
  }, [activeSite, siteUrls])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PRIVACY_MODE_STORAGE_KEY,
        isPrivacyMode ? '1' : '0',
      )
    } catch {
      // Ignore persistence errors and keep in-memory state.
    }
  }, [isPrivacyMode])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      try {
        window.localStorage.setItem(SITE_URL_STORAGE_KEY, JSON.stringify(siteUrls))
      } catch {
        // Ignore persistence errors and keep in-memory state.
      }
    }, 200)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [siteUrls])

  useEffect(() => {
    void chrome.storage.local
      .get(DIAGNOSTIC_CAPTURE_STORAGE_KEY)
      .then((result) => {
        setCaptureFailurePayload(readDiagnosticCaptureSetting(result))
      })
      .catch(() => {
        setCaptureFailurePayload(DEFAULT_DIAGNOSTIC_CAPTURE_ENABLED)
      })
  }, [])

  const itemGroups = useLiveQuery(
    async () => {
      if (!activeSiteId) {
        return []
      }

      return listItemGroupsBySite(activeSiteId, 200)
    },
    [activeSiteId],
    [],
  )

  const recentRuns = useLiveQuery(
    async () => {
      if (!activeSiteId) {
        return []
      }

      return listCrawlRunsBySite(activeSiteId, 10)
    },
    [activeSiteId],
    [],
  )
  const latestRun = recentRuns[0] ?? null
  const needsParserAttention = useMemo(
    () => hasConsecutiveParserFailures(recentRuns),
    [recentRuns],
  )

  const itemCountsBySite = useLiveQuery(
    async () => listItemCountSummariesBySite(targetSites.map((site) => site.id)),
    [],
    EMPTY_COUNTS_BY_SITE,
  )

  const activeSiteCounts = activeSiteId
    ? (itemCountsBySite[activeSiteId] ?? { itemCount: 0, groupCount: 0 })
    : { itemCount: 0, groupCount: 0 }
  const totalStoredItemCount = useMemo(
    () =>
      Object.values(itemCountsBySite).reduce(
        (total, siteCount) => total + siteCount.itemCount,
        0,
      ),
    [itemCountsBySite],
  )

  const backfillProgress = useLiveQuery(getItemBackfillProgress, [], undefined)

  useEffect(() => {
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let idleId: number | undefined

    const runBatch = async () => {
      if (cancelled) return
      const progress = await runItemSignatureBackfillBatch(100)
      if (!cancelled && !progress.complete) schedule()
    }
    const schedule = () => {
      if ('requestIdleCallback' in window) {
        idleId = window.requestIdleCallback(() => void runBatch(), { timeout: 1500 })
      } else {
        timeoutId = globalThis.setTimeout(() => void runBatch(), 50)
      }
    }
    schedule()
    return () => {
      cancelled = true
      if (idleId !== undefined) window.cancelIdleCallback(idleId)
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId)
    }
  }, [])

  async function handleOpenSite(siteId: string): Promise<void> {
    const site = TARGET_SITE_BY_ID.get(siteId)
    const siteName = site?.name ?? siteId
    const targetUrl = (siteUrls[siteId] ?? site?.url ?? '').trim()
    setActiveSiteId(siteId)

    const response = await sendRuntimeRequest<OpenTargetSiteResult>({
      type: 'OPEN_TARGET_SITE',
      payload: { siteId, targetUrl },
    })

    if (!response.ok) {
      setStatus({
        kind: 'error',
        message: `${mapError(response.error.code)}${response.error.detail ? ` (${response.error.detail})` : ''}`,
      })
      return
    }

    setStatus({
      kind: 'success',
      message: `${siteName} 사이트로 현재 탭을 이동했습니다.`,
    })
  }

  async function handleCrawl(): Promise<void> {
    if (!activeSiteId) {
      setStatus({ kind: 'error', message: '먼저 대상 사이트를 선택해주세요.' })
      return
    }

    setIsCrawling(true)
    setStatus({ kind: 'loading', message: 'HTML 수집과 파싱을 진행 중입니다...' })

    const response = await sendRuntimeRequest<CrawlSummary>({
      type: 'CRAWL_ACTIVE_TAB',
      payload: {
        siteId: activeSiteId,
        targetUrl: activeSiteUrl.trim(),
        captureFailurePayload,
      },
    })

    setIsCrawling(false)

    if (!response.ok) {
      setStatus({
        kind: 'error',
        message: `${mapError(response.error.code)}${response.error.detail ? ` (${response.error.detail})` : ''}`,
      })
      return
    }

    if (response.data.status === 'partial') {
      setStatus({
        kind: 'warning',
        message: `${response.data.parsedCount}건 파싱, 고유 신규 ${response.data.uniqueInsertedCount}건 / 유사 그룹 ${response.data.similarGroupedCount}건 / 정확 중복 ${response.data.exactDuplicateCount}건 / 탈락 ${response.data.rejectedCount}건입니다.`,
      })
      return
    }

    setStatus({
      kind: 'success',
      message: `${response.data.parsedCount}건 파싱, 고유 신규 ${response.data.uniqueInsertedCount}건 / 유사 그룹 ${response.data.similarGroupedCount}건 저장 / 정확 중복 ${response.data.exactDuplicateCount}건 제외했습니다.`,
    })
  }

  async function handleDiagnosticCaptureChange(enabled: boolean): Promise<void> {
    setCaptureFailurePayload(enabled)
    try {
      await chrome.storage.local.set({ [DIAGNOSTIC_CAPTURE_STORAGE_KEY]: enabled })
    } catch {
      setCaptureFailurePayload(!enabled)
      setStatus({ kind: 'error', message: '실패 원본 보관 설정을 저장하지 못했습니다.' })
    }
  }

  async function handleExportDiagnostic(run: CrawlRun): Promise<void> {
    setExportingRunId(run.runId)
    try {
      const artifact = await getCrawlDiagnostic(run.runId)
      const payloadText = artifact
        ? await decompressDiagnosticPayload(artifact)
        : undefined
      const exported = createCrawlDiagnosticExport(run, artifact, payloadText)
      downloadJson(`maltlock-diagnostic-${run.siteId}-${run.runId}.json`, exported)
    } catch {
      setStatus({ kind: 'error', message: '진단 파일을 내보내지 못했습니다.' })
    } finally {
      setExportingRunId(null)
    }
  }

  async function handleTogglePrivacyMode(): Promise<void> {
    if (isTogglingPrivacyMode) {
      return
    }

    const previousValue = isPrivacyMode
    const nextValue = !isPrivacyMode
    setIsTogglingPrivacyMode(true)
    setIsPrivacyMode(nextValue)

    try {
      const response = await sendRuntimeRequest<SetPrivacyScreenBlurResult>({
        type: 'SET_PRIVACY_SCREEN_BLUR',
        payload: { enabled: nextValue },
      })

      if (!response.ok) {
        setIsPrivacyMode(previousValue)
        setStatus({
          kind: 'warning',
          message: `${mapError(response.error.code)} 권한 또는 탭 상태를 확인하세요.`,
        })
        return
      }

      if (nextValue && response.data.appliedTabCount === 0) {
        setStatus({
          kind: 'warning',
          message:
            '사생활 모드 ON: 리스트 이미지는 숨겼지만, 현재 탭에는 블러를 적용하지 못했습니다. 일반 웹페이지 탭에서 다시 시도하세요.',
        })
        return
      }

      setStatus({
        kind: 'success',
        message: nextValue
          ? '사생활 모드 ON: 미리보기 이미지를 숨기고 현재 탭 화면을 흐리게 처리합니다.'
          : '사생활 모드 OFF: 미리보기 이미지와 탭 화면을 원래대로 표시합니다.',
      })
    } finally {
      setIsTogglingPrivacyMode(false)
    }
  }

  const handleDeleteItem = useCallback(async (itemId: string): Promise<void> => {
    setDeletingItemId(itemId)

    try {
      await deleteCrawledItem(itemId)
      await removePersistentThumbnail(itemId)
      setStatus({
        kind: 'success',
        message: '아이템 1건을 삭제했습니다.',
      })
    } catch {
      setStatus({
        kind: 'error',
        message: '아이템 삭제에 실패했습니다. 다시 시도하세요.',
      })
    } finally {
      setDeletingItemId(null)
    }
  }, [])

  const handleSeparateItem = useCallback(async (itemId: string): Promise<void> => {
    setSeparatingItemId(itemId)
    try {
      await excludeItemFromSimilarityGroup(itemId)
      setStatus({ kind: 'success', message: '항목을 유사 그룹에서 분리했습니다.' })
    } catch {
      setStatus({ kind: 'error', message: '그룹 분리에 실패했습니다.' })
    } finally {
      setSeparatingItemId(null)
    }
  }, [])

  const handleToggleGroup = useCallback((groupId: string): void => {
    setExpandedGroupIds((previous) => {
      const next = new Set(previous)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const handleOpenItemLink = useCallback(
    async (url: string, newTab: boolean): Promise<void> => {
      const response = await sendRuntimeRequest<OpenItemLinkResult>({
        type: 'OPEN_ITEM_LINK',
        payload: { url, newTab },
      })

      if (!response.ok) {
        setStatus({
          kind: 'error',
          message: `${mapError(response.error.code)}${response.error.detail ? ` (${response.error.detail})` : ''}`,
        })
      }
    },
    [],
  )

  const handleItemLinkClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, url: string): void => {
      event.preventDefault()
      void handleOpenItemLink(url, shouldOpenItemInNewTab(event))
    },
    [handleOpenItemLink],
  )

  const handleItemLinkAuxClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, url: string): void => {
      if (event.button !== 1) {
        return
      }

      event.preventDefault()
      void handleOpenItemLink(url, true)
    },
    [handleOpenItemLink],
  )

  function handleSiteUrlChange(siteId: string, value: string): void {
    setSiteUrls((previous) => ({
      ...previous,
      [siteId]: value,
    }))
  }

  function handleResetSiteUrl(siteId: string): void {
    const defaultUrl = TARGET_SITE_BY_ID.get(siteId)?.url
    if (!defaultUrl) {
      return
    }

    setSiteUrls((previous) => ({
      ...previous,
      [siteId]: defaultUrl,
    }))
  }

  useEffect(() => {
    if (!initialPrivacyModeRef.current) {
      return
    }

    void sendRuntimeRequest<SetPrivacyScreenBlurResult>({
      type: 'SET_PRIVACY_SCREEN_BLUR',
      payload: { enabled: true },
    }).then((response) => {
      if (response.ok && response.data.appliedTabCount > 0) {
        return
      }

      setStatus({
        kind: 'warning',
        message: response.ok
          ? '사생활 모드는 유지되지만, 현재 탭 블러를 적용하지 못했습니다. 일반 웹페이지 탭에서 다시 시도하세요.'
          : `${mapError(response.error.code)} 권한 또는 탭 상태를 확인하세요.`,
      })
    })
  }, [])

  const renderedItems = useMemo(() => {
    if (itemGroups.length === 0) {
      return (
        <li className="empty-row">
          <p>아직 저장된 아이템이 없습니다.</p>
          <p>사이트를 열고 크롤을 실행하면 결과가 여기에 쌓입니다.</p>
        </li>
      )
    }

    return itemGroups.map((group) => {
      const item = group.representative
      const titleLinkUrl = getTitleLinkUrl(item)
      const additionalItems = group.items.filter((value) => value.id !== item.id)
      const isExpanded = expandedGroupIds.has(group.id)

      return (
        <li key={group.id} className="item-row">
          <div className={`item-main ${isPrivacyMode ? 'item-main-privacy' : ''}`}>
            {!isPrivacyMode ? (
              item.previewImageUrl ? (
                <CachedThumbnail
                  itemId={item.id}
                  sourceUrl={item.previewImageUrl}
                  title={item.title}
                />
              ) : (
                <div className="item-preview item-preview-empty">No Image</div>
              )
            ) : null}
            <div className="item-content">
              <a
                href={titleLinkUrl}
                className="item-title"
                title={item.title}
                onClick={(event) => {
                  handleItemLinkClick(event, titleLinkUrl)
                }}
                onAuxClick={(event) => {
                  handleItemLinkAuxClick(event, titleLinkUrl)
                }}
              >
                {item.title}
              </a>
              <a
                href={item.url}
                className="item-url"
                title={item.url}
                onClick={(event) => {
                  handleItemLinkClick(event, item.url)
                }}
                onAuxClick={(event) => {
                  handleItemLinkAuxClick(event, item.url)
                }}
              >
                {item.url}
              </a>
              <div className="item-meta">
                <div className="item-meta-tags">
                  <span className="meta-tag">{formatDateTime(item.crawledAt)}</span>
                  {additionalItems.length > 0 ? (
                    <button
                      type="button"
                      className="group-toggle"
                      aria-expanded={isExpanded}
                      onClick={() => handleToggleGroup(group.id)}
                    >
                      유사 {additionalItems.length}건 {isExpanded ? '접기' : '보기'}
                    </button>
                  ) : null}
                </div>
                {item.summary ? (
                  <span className="item-summary" title={item.summary}>
                    {item.summary}
                  </span>
                ) : null}
              </div>
              <div className="item-actions">
                <button
                  type="button"
                  className="delete-button"
                  onClick={() => {
                    void handleDeleteItem(item.id)
                  }}
                  disabled={deletingItemId === item.id}
                >
                  {deletingItemId === item.id ? '삭제 중...' : '삭제'}
                </button>
              </div>
            </div>
          </div>
          {isExpanded ? (
            <ul className="group-members">
              {additionalItems.map((member) => {
                const memberLinkUrl = getTitleLinkUrl(member)
                const siteName = TARGET_SITE_BY_ID.get(member.siteId)?.name ?? member.siteId
                return (
                  <li key={member.id} className="group-member">
                    <div className="group-member-heading">
                      <a
                        href={memberLinkUrl}
                        className="group-member-title"
                        onClick={(event) => handleItemLinkClick(event, memberLinkUrl)}
                        onAuxClick={(event) => handleItemLinkAuxClick(event, memberLinkUrl)}
                      >
                        {member.title}
                      </a>
                      <span className="group-source">{siteName}</span>
                    </div>
                    <p className="group-match-reason">
                      {getGroupReasonLabel(member.groupReason ?? group.reason)}
                      {member.groupScore !== undefined
                        ? ` · ${(member.groupScore * 100).toFixed(1)}%`
                        : ''}
                    </p>
                    <div className="group-member-actions">
                      {group.reason !== 'global-identity' ? (
                        <button
                          type="button"
                          className="separate-button"
                          onClick={() => void handleSeparateItem(member.id)}
                          disabled={separatingItemId === member.id}
                        >
                          {separatingItemId === member.id ? '분리 중...' : '그룹에서 분리'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="delete-button"
                        onClick={() => void handleDeleteItem(member.id)}
                        disabled={deletingItemId === member.id}
                      >
                        {deletingItemId === member.id ? '삭제 중...' : '삭제'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </li>
      )
    })
  }, [
    deletingItemId,
    expandedGroupIds,
    handleDeleteItem,
    handleItemLinkAuxClick,
    handleItemLinkClick,
    handleSeparateItem,
    handleToggleGroup,
    isPrivacyMode,
    itemGroups,
    separatingItemId,
  ])

  return (
    <main className={`panel-shell ${isListExpanded ? 'panel-shell-list-expanded' : ''}`}>
      <header className="panel-header">
        <div className="panel-header-top">
          <div className="brand-lockup">
            <img
              src="icons/maltlock-32.png"
              alt=""
              className="brand-icon"
              aria-hidden="true"
            />
            <h1>Maltlock Crawler</h1>
          </div>
          <span className="header-badge">Side Panel</span>
        </div>
        <p className="panel-subtitle">현재 탭 이동 → 크롤 실행 → 저장 결과 검토</p>
        <div className="header-meta">
          <span className="meta-pill">선택: {activeSiteName}</span>
          <span className="meta-pill">
            선택 사이트: {activeSiteCounts.groupCount}그룹 / {activeSiteCounts.itemCount}건
          </span>
          <span className="meta-pill">전체 저장: {totalStoredItemCount}건</span>
        </div>
      </header>

      <section className="section-block">
        <div className="section-heading">
          <h2>1. 대상 사이트</h2>
          <p>버튼을 누르면 현재 활성 탭을 해당 사이트로 이동하고 현재 대상으로 설정합니다.</p>
        </div>
        <div className="site-grid">
          {targetSites.map((site) => (
            <button
              key={site.id}
              type="button"
              className={`chip ${activeSiteId === site.id ? 'chip-active' : ''}`}
              aria-pressed={activeSiteId === site.id}
              onClick={() => {
                void handleOpenSite(site.id)
              }}
            >
              <span className="chip-label">{site.name}</span>
              <span className="chip-count">
                {itemCountsBySite[site.id]?.groupCount ?? 0} /{' '}
                {itemCountsBySite[site.id]?.itemCount ?? 0}
              </span>
            </button>
          ))}
        </div>
        {activeSite ? (
          <div className="site-url-editor">
            <label className="site-url-label" htmlFor="site-url-input">
              {activeSite.name} URL 커스터마이즈
            </label>
            <div className="site-url-row">
              <input
                id="site-url-input"
                type="url"
                className="site-url-input"
                value={activeSiteUrl}
                onChange={(event) => {
                  handleSiteUrlChange(activeSite.id, event.target.value)
                }}
                placeholder="https://example.com"
                spellCheck={false}
              />
              <button
                type="button"
                className="site-url-reset"
                onClick={() => {
                  handleResetSiteUrl(activeSite.id)
                }}
              >
                기본값
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>2. 크롤 실행</h2>
          <p>활성 탭의 HTML을 수집해 파싱 후 로컬 DB에 저장합니다.</p>
        </div>
        <button
          type="button"
          className="crawl-button"
          onClick={() => {
            void handleCrawl()
          }}
          disabled={isCrawling}
        >
          {isCrawling ? '크롤링 중...' : '지금 크롤 실행'}
        </button>
        <p
          className={`status-line status-${status.kind}`}
          role="status"
          aria-live="polite"
        >
          <span className="status-label">{STATUS_LABEL_BY_KIND[status.kind]}</span>
          <span>{status.message}</span>
        </p>
        <details className="diagnostics-panel">
          <summary>
            <span>실행 진단</span>
            {needsParserAttention ? (
              <span className="diagnostics-alert">파싱 점검 필요</span>
            ) : (
              <span className="diagnostics-count">최근 {recentRuns.length}건</span>
            )}
          </summary>
          <div className="diagnostics-body">
            {backfillProgress && !backfillProgress.complete ? (
              <div className="backfill-progress" role="status">
                <span>기존 데이터 identity 생성</span>
                <strong>
                  {backfillProgress.processed} / {backfillProgress.total}
                </strong>
              </div>
            ) : null}
            <label className="diagnostics-toggle">
              <input
                type="checkbox"
                checked={captureFailurePayload}
                onChange={(event) => {
                  void handleDiagnosticCaptureChange(event.target.checked)
                }}
              />
              <span>파서 실패 원본 로컬 보관</span>
            </label>
            {recentRuns.length > 0 ? (
              <ul className="run-history">
                {recentRuns.map((run) => (
                  <li key={run.runId} className={`run-history-row run-${run.status}`}>
                    <div className="run-history-header">
                      <span className="run-status">{getRunStatusLabel(run)}</span>
                      <time dateTime={new Date(run.finishedAt).toISOString()}>
                        {formatDateTime(run.finishedAt)}
                      </time>
                      <button
                        type="button"
                        className="diagnostic-export-button"
                        onClick={() => {
                          void handleExportDiagnostic(run)
                        }}
                        disabled={exportingRunId === run.runId}
                      >
                        {exportingRunId === run.runId ? '내보내는 중' : '진단 내보내기'}
                      </button>
                    </div>
                    <p>{getRunMetrics(run)}</p>
                    <p className="run-detail">
                      단계 {run.stage ?? '-'} · {run.durationMs ?? run.finishedAt - run.startedAt}ms
                      {run.errorCode ? ` · ${run.errorCode}` : ''}
                    </p>
                    {run.errorDetail ? (
                      <p className="run-error-detail" title={run.errorDetail}>
                        {run.errorDetail}
                      </p>
                    ) : null}
                    {run.warnings && run.warnings.length > 0 ? (
                      <p className="run-warning">경고: {run.warnings.join(', ')}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="diagnostics-empty">실행 기록이 없습니다.</p>
            )}
          </div>
        </details>
      </section>

      <section className="section-block list-block">
        <div className="list-header">
          <div className="section-heading">
            <h2>3. 저장 리스트</h2>
            <p>최근 수집 결과를 확인하고 필요 없는 아이템을 정리하세요.</p>
          </div>
          <div className="list-controls">
            <button
              type="button"
              className="list-expand-toggle"
              aria-pressed={isListExpanded}
              onClick={() => {
                setIsListExpanded((previousValue) => !previousValue)
              }}
            >
              {isListExpanded ? '기본 보기' : '리스트 크게 보기'}
            </button>
            <button
              type="button"
              className={`privacy-toggle ${isPrivacyMode ? 'privacy-toggle-on' : ''}`}
              aria-pressed={isPrivacyMode}
              onClick={() => {
                void handleTogglePrivacyMode()
              }}
              disabled={isTogglingPrivacyMode}
            >
              {isTogglingPrivacyMode
                ? '사생활 모드 적용 중...'
                : `사생활 모드 ${isPrivacyMode ? 'ON' : 'OFF'}`}
            </button>
          </div>
        </div>
        <p className="run-meta">
          {latestRun
            ? `최근 실행: ${formatDateTime(latestRun.finishedAt)} · ${getRunStatusLabel(latestRun)}`
            : '최근 실행 기록이 없습니다.'}
        </p>

        <ul className="item-list">{renderedItems}</ul>
      </section>
    </main>
  )
}

export default App
