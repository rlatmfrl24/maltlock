import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { normalizeKissjavUrl, targetSites } from '../config/targets'
import {
  deleteCrawledItem,
  deleteCrawledItems,
  listCrawledItemIds,
  countCrawledItems,
  getCrawlDiagnostic,
  getItemBackfillProgress,
  listItemCountsBySite,
  listItemsBySite,
  listCrawlRunsBySite,
  runItemSignatureBackfillBatch,
} from '../db/repository'
import { sendRuntimeRequest } from '../extension/runtime-client'
import { crawlRangePages } from '../extension/range-auto-crawl'
import { crawlTwidougaPages } from '../extension/twidouga-auto-crawl'
import { crawlNimiPlatforms } from '../extension/nimi-auto-crawl'
import { getItemSourcePlatform, NIMI_PLATFORMS, NIMI_PLATFORM_LABELS } from '../extension/nimi'
import type { AutoCrawlProgress } from '../extension/auto-crawl'
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
  CrawlRun,
  CrawlErrorCode,
  CrawlSummary,
  OpenTargetSiteResult,
  OpenItemLinkResult,
  SetPrivacyScreenBlurResult,
  NimiPlatform,
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
const ITEM_DATE_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const TARGET_SITE_BY_ID = new Map(targetSites.map((site) => [site.id, site]))
const EMPTY_COUNTS_BY_SITE: Record<string, number> = Object.fromEntries(
  targetSites.map((site) => [site.id, 0]),
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
      if (site.id === 'kissjav-most-popular-week') {
        try { merged[site.id] = normalizeKissjavUrl(trimmed).href }
        catch { /* Keep custom input for the existing URL validation. */ }
      }
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
    `탈락 ${run.rejectedCount ?? 0}`,
  ].join(' · ')
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
  const [step, setStep] = useState<'target' | 'crawl' | 'list'>('target')
  const [isCrawling, setIsCrawling] = useState(false)
  const [twidougaCrawlMode, setTwidougaCrawlMode] = useState('current')
  const [nimiCrawlMode, setNimiCrawlMode] = useState('all')
  const [nimiSourceFilter, setNimiSourceFilter] = useState<NimiPlatform | ''>('')
  const activeSourceFilter = activeSiteId === 'nimi-tw-ranking' ? nimiSourceFilter || undefined : undefined
  const [rangeCrawlSettings, setRangeCrawlSettings] = useState<Record<string, { mode: string; startPage: string; endPage: string }>>({
    'kone-pornvideo-hot': { mode: 'current', startPage: '1', endPage: '5' },
    'kissjav-most-popular-week': { mode: 'current', startPage: '1', endPage: '3' },
    'missav-weekly-views': { mode: 'current', startPage: '1', endPage: '3' },
  })
  const activeRangeSettings = rangeCrawlSettings[activeSiteId]
  const [isStoppingCrawl, setIsStoppingCrawl] = useState(false)
  const autoCrawlRef = useRef<AbortController | null>(null)
  const [isPrivacyMode, setIsPrivacyMode] = useState(getInitialPrivacyMode)
  const [isTogglingPrivacyMode, setIsTogglingPrivacyMode] = useState(false)
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null)
  const deleteFocusRef = useRef<{ removedId: string; nextId?: string } | null>(null)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(() => new Set())
  const [pendingDeletion, setPendingDeletion] = useState<{ ids: string[]; scope: string } | null>(null)
  const [isBulkDeleting, setIsBulkDeleting] = useState(false)
  const [captureFailurePayload, setCaptureFailurePayload] = useState(
    DEFAULT_DIAGNOSTIC_CAPTURE_ENABLED,
  )
  const [exportingRunId, setExportingRunId] = useState<string | null>(null)
  const initialPrivacyModeRef = useRef(isPrivacyMode)

  const activeSite = useMemo(() => TARGET_SITE_BY_ID.get(activeSiteId), [activeSiteId])
  const activeSiteName = activeSite?.name ?? '-'

  useEffect(() => () => autoCrawlRef.current?.abort(), [])

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

  const items = useLiveQuery(
    async () => {
      if (!activeSiteId) {
        return []
      }

      return listItemsBySite(activeSiteId, 200, activeSourceFilter)
    },
    [activeSiteId, activeSourceFilter],
    [],
  )

  useEffect(() => {
    const pending = deleteFocusRef.current
    if (!pending || deletingItemId) return
    if (pending.nextId !== pending.removedId && items.some((item) => item.id === pending.removedId)) return
    if (step === 'list' && document.activeElement === document.body) {
      const nextButton = pending.nextId
        ? document.querySelector<HTMLButtonElement>(`.item-delete[data-item-id="${CSS.escape(pending.nextId)}"]`)
        : null
      ;(nextButton ?? document.getElementById('list-heading'))?.focus()
    }
    deleteFocusRef.current = null
  }, [items, deletingItemId, step])

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
  const needsParserAttention = useMemo(
    () => hasConsecutiveParserFailures(recentRuns),
    [recentRuns],
  )

  const itemCountsBySite = useLiveQuery(
    async () => listItemCountsBySite(targetSites.map((site) => site.id)),
    [],
    EMPTY_COUNTS_BY_SITE,
  )

  const activeSiteCount = itemCountsBySite[activeSiteId] ?? 0
  const filteredCount = useLiveQuery(async () => activeSourceFilter ? countCrawledItems(activeSiteId, activeSourceFilter) : 0,
    [activeSiteId, activeSourceFilter], 0)
  const visibleCount = activeSourceFilter ? filteredCount : activeSiteCount
  const totalStoredItemCount = useLiveQuery(countCrawledItems, [], 0)

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
    setStep('crawl')
  }

  function handleRangeSettingChange(key: 'mode' | 'startPage' | 'endPage', value: string): void {
    setRangeCrawlSettings((current) => ({ ...current, [activeSiteId]: { ...current[activeSiteId], [key]: value } }))
  }

  async function handleCrawl(): Promise<void> {
    if (isCrawling) return
    if (!activeSiteId) {
      setStatus({ kind: 'error', message: '먼저 대상 사이트를 선택해주세요.' })
      return
    }

    setIsCrawling(true)
    setIsStoppingCrawl(false)
    setStatus({ kind: 'loading', message: 'HTML 수집과 파싱을 진행 중입니다...' })

    if (activeRangeSettings?.mode === 'all' ||
      (activeSiteId === 'twidouga-ranking-t1' && twidougaCrawlMode === 'all') ||
      (activeSiteId === 'nimi-tw-ranking' && nimiCrawlMode === 'all')) {
      const controller = new AbortController()
      autoCrawlRef.current = controller
      const isKone = activeSiteId === 'kone-pornvideo-hot'
      const isNimi = activeSiteId === 'nimi-tw-ranking'
      const isRangeCrawl = !!activeRangeSettings
      const pageLabel = (page: number) => isNimi ? NIMI_PLATFORM_LABELS[NIMI_PLATFORMS[page - 1]] : isRangeCrawl ? `${page}페이지` : page === 1 ? '1–10위' : '11–20위'
      try {
        const options = {
          targetUrl: activeSiteUrl.trim(), captureFailurePayload, signal: controller.signal,
          onProgress: (progress: AutoCrawlProgress) => setStatus({
            kind: 'loading',
            message: `${pageLabel(progress.page)} ${controller.signal.aborted ? '중지 중' : '확인 중'} · ${progress.completedPages}페이지 처리 · 신규 ${progress.insertedCount}건 저장 · 정확 중복 ${progress.duplicateCount}건`,
          }),
        }
        const result = await (isNimi ? crawlNimiPlatforms({ ...options, onProgress: (progress) => setStatus({
          kind: 'loading', message: `${pageLabel(progress.page)} 확인 중 · ${progress.completedPages}/4개 플랫폼 처리 · 신규 ${progress.insertedCount}건 저장 · 정확 중복 ${progress.duplicateCount}건${progress.failures.length ? ` · 실패 ${progress.failures.join(' · ')}` : ''}`,
        }) }) : isRangeCrawl ? crawlRangePages({
          ...options, siteId: activeSiteId, startPage: Number(activeRangeSettings.startPage),
          endPage: activeRangeSettings.endPage.trim() ? Number(activeRangeSettings.endPage) : undefined,
        }) : crawlTwidougaPages(options))
        const successLabel = isNimi ? '4개 플랫폼 주간 수집 완료' : isRangeCrawl
          ? isKone && activeRangeSettings.startPage === '1' && !activeRangeSettings.endPage.trim()
            ? '전체 수집 완료' : `범위 수집 완료 (${activeRangeSettings.startPage}–${result.progress.page}페이지)`
          : '1–20위 수집 완료'
        const label = result.status === 'success' ?
          successLabel
          : result.status === 'stopped' ? '수집 중지'
            : isNimi ? '4개 플랫폼 수집 일부 완료' : `${pageLabel(result.progress.page)}에서 ${result.progress.completedPages ? '일부 완료' : '수집 실패'}`
        setStatus({
          kind: result.status === 'success' ? 'success' : result.status === 'stopped' || result.progress.completedPages > 0 ? 'warning' : 'error',
          message: `${label} · ${result.progress.completedPages}${isNimi ? '/4개 플랫폼' : '페이지'} 처리 · 신규 ${result.progress.insertedCount}건 저장 · 정확 중복 ${result.progress.duplicateCount}건${result.progress.rejectedCount ? ` · 탈락 ${result.progress.rejectedCount}건` : ''}${result.detail ? ` · ${result.detail}` : ''}`,
        })
        if (result.status === 'success') setStep('list')
      } finally {
        autoCrawlRef.current = null
        setIsCrawling(false)
        setIsStoppingCrawl(false)
      }
      return
    }

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
        message: `${response.data.parsedCount}건 파싱, 신규 ${response.data.insertedCount}건 저장 / 정확 중복 ${response.data.exactDuplicateCount}건 / 탈락 ${response.data.rejectedCount}건입니다.`,
      })
      return
    }

    setStatus({
      kind: 'success',
      message: `${response.data.parsedCount}건 파싱, 신규 ${response.data.insertedCount}건 저장 / 정확 중복 ${response.data.exactDuplicateCount}건 제외했습니다.`,
    })
    setStep('list')
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
      setSelectedItemIds((previous) => {
        const next = new Set(previous)
        next.delete(itemId)
        return next
      })
      await removePersistentThumbnail(itemId)
      setStatus({
        kind: 'success',
        message: '아이템 1건을 삭제했습니다.',
      })
    } catch {
      if (deleteFocusRef.current?.removedId === itemId) deleteFocusRef.current.nextId = itemId
      setStatus({
        kind: 'error',
        message: '아이템 삭제에 실패했습니다. 다시 시도하세요.',
      })
    } finally {
      setDeletingItemId(null)
    }
  }, [])

  const handleSelectItem = useCallback((itemId: string, checked: boolean) => {
    setSelectedItemIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(itemId)
      else next.delete(itemId)
      return next
    })
  }, [])

  async function handleSelectSiteItems(): Promise<void> {
    try {
      const ids = await listCrawledItemIds(activeSiteId, activeSourceFilter)
      setSelectedItemIds((previous) => new Set([...previous, ...ids]))
    } catch {
      setStatus({ kind: 'error', message: '항목을 선택하지 못했습니다. 다시 시도하세요.' })
    }
  }

  async function handlePrepareDeleteAll(): Promise<void> {
    try {
      const ids = await listCrawledItemIds()
      if (ids.length) setPendingDeletion({ ids, scope: '전체 사이트' })
    } catch {
      setStatus({ kind: 'error', message: '삭제할 항목을 확인하지 못했습니다.' })
    }
  }

  async function handleBulkDelete(): Promise<void> {
    if (!pendingDeletion || isBulkDeleting) return
    setIsBulkDeleting(true)
    try {
      const deletedIds = await deleteCrawledItems(pendingDeletion.ids)
      const requestedIds = new Set(pendingDeletion.ids)
      setSelectedItemIds((previous) => new Set([...previous].filter((id) => !requestedIds.has(id))))
      const cleanup = await Promise.allSettled(deletedIds.map(removePersistentThumbnail))
      const cacheFailed = cleanup.some((result) => result.status === 'rejected')
      setStatus({ kind: cacheFailed ? 'warning' : 'success',
        message: `항목 ${deletedIds.length}건을 일괄 삭제했습니다.${cacheFailed ? ' 일부 썸네일 캐시 정리에 실패했습니다.' : ''}` })
      setPendingDeletion(null)
    } catch {
      setStatus({ kind: 'error', message: '일괄 삭제에 실패했습니다. 항목을 확인하고 다시 시도하세요.' })
    } finally {
      setIsBulkDeleting(false)
    }
  }

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
    if (items.length === 0) {
      return (
        <li className="empty-row">
          <p>{activeSourceFilter ? `${NIMI_PLATFORM_LABELS[activeSourceFilter]}에 저장된 항목이 없습니다.` : '아직 저장된 항목이 없습니다.'}</p>
          <p>{activeSourceFilter ? '다른 출처를 선택하거나 이 사이트를 수집하세요.' : '아래의 ‘이 사이트 수집’으로 항목을 추가하세요.'}</p>
        </li>
      )
    }

    return items.map((item, index) => {
      const sourcePlatform = getItemSourcePlatform(item)
      const titleLinkUrl = getTitleLinkUrl(item)

      return (
        <li key={item.id} className={`item-row${selectedItemIds.has(item.id) ? ' item-row-selected' : ''}`}>
          <div className={`item-main ${isPrivacyMode ? 'item-main-privacy' : ''}`}>
            <label className="item-selection">
              <input type="checkbox" className="item-select" aria-label={`${item.title} 선택`}
                checked={selectedItemIds.has(item.id)} disabled={isBulkDeleting || !!pendingDeletion}
                onChange={(event) => handleSelectItem(item.id, event.target.checked)} />
            </label>
            <div className="item-content">
              <a
                href={titleLinkUrl}
                className="item-title"
                title={`${item.title}\n${titleLinkUrl}`}
                onClick={(event) => {
                  handleItemLinkClick(event, titleLinkUrl)
                }}
                onAuxClick={(event) => {
                  handleItemLinkAuxClick(event, titleLinkUrl)
                }}
              >
                {item.title}
              </a>
              {item.siteId === 'nimi-tw-ranking' ? (
                <span className="meta-tag source-platform">NimiWiki · {sourcePlatform ? NIMI_PLATFORM_LABELS[sourcePlatform] : '출처 미확인'}</span>
              ) : null}
              {item.summary && item.summary !== titleLinkUrl && item.summary !== item.url ? (
                <span className="item-summary" title={item.summary}>
                  {item.summary}
                </span>
              ) : null}
              <time className="item-date" dateTime={new Date(item.crawledAt).toISOString()}
                title={`수집: ${formatDateTime(item.crawledAt)}`} aria-label={`수집: ${formatDateTime(item.crawledAt)}`}>
                {ITEM_DATE_FORMATTER.format(item.crawledAt)}
              </time>
            </div>
            {!isPrivacyMode || titleLinkUrl !== item.url ? (
              <div className="item-media">
                {!isPrivacyMode ? item.previewImageUrl ? (
                  <CachedThumbnail itemId={item.id} sourceUrl={item.previewImageUrl} title={item.title} />
                ) : <div className="item-preview item-preview-empty">No Image</div> : null}
                {titleLinkUrl !== item.url ? (
                  <a href={item.url} className="item-url" title={item.url}
                    aria-label={`${item.title} 영상 열기`}
                    onClick={(event) => handleItemLinkClick(event, item.url)}
                    onAuxClick={(event) => handleItemLinkAuxClick(event, item.url)}>
                    영상 열기
                  </a>
                ) : null}
              </div>
            ) : null}
            <button type="button" className="delete-button item-delete" data-item-id={item.id}
              aria-label={`${item.title} ${deletingItemId === item.id ? '삭제 중' : '삭제'}`}
              aria-busy={deletingItemId === item.id}
              onClick={(event) => {
                if (event.detail === 0) deleteFocusRef.current = { removedId: item.id, nextId: items[index + 1]?.id ?? items[index - 1]?.id }
                void handleDeleteItem(item.id)
              }}
              disabled={!!deletingItemId || isBulkDeleting || !!pendingDeletion}>
              {deletingItemId !== item.id ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
                </svg>
              ) : null}
              <span>{deletingItemId === item.id ? '삭제 중' : '삭제'}</span>
            </button>
          </div>
        </li>
      )
    })
  }, [
    deletingItemId,
    handleDeleteItem,
    handleSelectItem,
    handleItemLinkAuxClick,
    handleItemLinkClick,
    isPrivacyMode,
    items,
    selectedItemIds,
    isBulkDeleting,
    pendingDeletion,
    activeSourceFilter,
  ])

  return (
    <main className="panel-shell">
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
          <button type="button" className={`privacy-toggle ${isPrivacyMode ? 'privacy-toggle-on' : ''}`}
            aria-pressed={isPrivacyMode} disabled={isTogglingPrivacyMode}
            onClick={() => void handleTogglePrivacyMode()}>
            {isTogglingPrivacyMode ? '적용 중...' : `사생활 모드 ${isPrivacyMode ? 'ON' : 'OFF'}`}
          </button>
        </div>
      </header>

      <nav className="step-nav" aria-label="수집 단계">
        {([['target', '대상 선택'], ['crawl', '수집 실행'], ['list', '저장 목록']] as const).map(([value, label], index) => (
          <button key={value} type="button" aria-current={step === value ? 'step' : undefined}
            aria-controls={`step-${value}`} onClick={() => setStep(value)}>
            <span className="step-number">{index + 1}</span>{label}
            {value === 'crawl' && isCrawling ? <span className="running-dot" aria-label="수집 진행 중" /> : null}
          </button>
        ))}
      </nav>

      <div className="step-body">
      <section id="step-target" className="section-block step-page" hidden={step !== 'target'} aria-labelledby="target-heading">
        <div className="section-heading">
          <h2 id="target-heading">어디에서 수집할까요?</h2>
          <p>사이트를 선택하면 현재 탭에서 열고 수집 설정으로 이동합니다.</p>
        </div>
        <div className="site-grid">
          {targetSites.map((site) => (
            <button
              key={site.id}
              type="button"
              className={`chip ${activeSiteId === site.id ? 'chip-active' : ''}`}
              aria-pressed={activeSiteId === site.id}
              disabled={isCrawling}
              onClick={() => {
                void handleOpenSite(site.id)
              }}
            >
              <span className="chip-label">{site.name}</span>
              <span className="chip-count">
                {itemCountsBySite[site.id] ?? 0}건
              </span>
            </button>
          ))}
        </div>
        {activeSite ? (
          <details className="site-settings">
            <summary>사이트 주소 설정 <span>{activeSiteName}</span></summary>
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
                disabled={isCrawling}
                onChange={(event) => {
                  handleSiteUrlChange(activeSite.id, event.target.value)
                }}
                placeholder="https://example.com"
                spellCheck={false}
              />
              <button
                type="button"
                className="site-url-reset"
                disabled={isCrawling}
                onClick={() => {
                  handleResetSiteUrl(activeSite.id)
                }}
              >
                기본값
              </button>
            </div>
          </div>
          </details>
        ) : null}
        <div className="target-library">
          <span>이미 저장한 항목이 있나요?</span>
          <button type="button" className="text-button" onClick={() => setStep('list')}>저장 목록 바로 보기</button>
        </div>
      </section>

      <section id="step-crawl" className="section-block step-page" hidden={step !== 'crawl'} aria-labelledby="crawl-heading">
        <div className="section-heading">
          <h2 id="crawl-heading">{activeSiteName} 수집</h2>
          <p>범위를 확인하고 수집을 시작하세요. 결과는 페이지마다 저장합니다.</p>
        </div>
        <div className="source-summary">
          <span title={activeSiteUrl}>{activeSiteUrl}</span>
          <button type="button" className="text-button" disabled={isCrawling}
            onClick={() => setStep('target')}>대상 변경</button>
        </div>
        {activeRangeSettings ? (
          <div className="site-url-editor">
            <label className="site-url-label" htmlFor="range-crawl-mode">{activeSiteId === 'kone-pornvideo-hot' ? '코네' : activeSiteName} 수집 범위</label>
            <select id="range-crawl-mode" className="site-url-input" value={activeRangeSettings.mode}
              disabled={isCrawling} onChange={(event) => handleRangeSettingChange('mode', event.target.value)}>
              <option value="current">현재 페이지</option>
              <option value="all">{activeSiteId === 'kone-pornvideo-hot' ? '인기글 페이지 범위 자동 수집' : '페이지 범위 자동 수집'}</option>
            </select>
            {activeRangeSettings.mode === 'all' ? (
              <>
                <div className="crawl-range">
                  <label>시작 페이지<input type="number" min="1" step="1" className="site-url-input"
                    value={activeRangeSettings.startPage} disabled={isCrawling} onChange={(event) => handleRangeSettingChange('startPage', event.target.value)} /></label>
                  <label>끝 페이지<input type="number" min={Number(activeRangeSettings.startPage) || 1} step="1" className="site-url-input"
                    value={activeRangeSettings.endPage} placeholder={activeSiteId === 'kone-pornvideo-hot' ? '마지막 페이지' : '필수'}
                    disabled={isCrawling} onChange={(event) => handleRangeSettingChange('endPage', event.target.value)} /></label>
                </div>
                <p className="crawl-hint">지정 범위를 모두 확인합니다. {activeSiteId === 'kone-pornvideo-hot' ? '끝 페이지를 비우면 마지막까지 수집합니다. ' : '정렬을 유지하며 순회합니다. '}
                  패널과 {activeSiteName} 탭을 열어 두세요.</p>
              </>
            ) : null}
          </div>
        ) : null}
        {activeSiteId === 'twidouga-ranking-t1' ? (
          <div className="site-url-editor">
            <label className="site-url-label" htmlFor="twidouga-crawl-mode">TwiDouga 수집 범위</label>
            <select id="twidouga-crawl-mode" className="site-url-input" value={twidougaCrawlMode}
              disabled={isCrawling} onChange={(event) => setTwidougaCrawlMode(event.target.value)}>
              <option value="current">현재 페이지</option>
              <option value="all">1–20위 자동 수집</option>
            </select>
            {twidougaCrawlMode === 'all' ? (
              <p className="crawl-hint">24시간 랭킹의 1–10위와 11–20위를 차례로 확인합니다. 패널과 TwiDouga 탭을 열어 두세요.</p>
            ) : null}
          </div>
        ) : null}
        {activeSiteId === 'nimi-tw-ranking' ? (
          <div className="site-url-editor">
            <label className="site-url-label" htmlFor="nimi-crawl-mode">NimiWiki 수집 범위</label>
            <select id="nimi-crawl-mode" className="site-url-input" value={nimiCrawlMode} disabled={isCrawling}
              onChange={(event) => setNimiCrawlMode(event.target.value)}>
              <option value="all">4개 플랫폼 주간 인기 자동 수집</option>
              <option value="current">현재 목록 수집</option>
            </select>
            {nimiCrawlMode === 'all' ? <p className="crawl-hint">트위터 → 인스타그램 → 틱톡 → 블루스카이의 조회수 기준 주간 인기 목록을 순환합니다. 패널과 NimiWiki 탭을 열어 두세요.</p> : null}
          </div>
        ) : null}
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

      <section id="step-list" className="section-block list-block" hidden={step !== 'list'} aria-labelledby="list-heading">
        <div className="list-header">
          <div className="section-heading">
            <h2 id="list-heading" tabIndex={-1}>저장 목록</h2>
            <p>{visibleCount}건</p>
          </div>
          <div className="list-controls">
            <select aria-label="목록 사이트" className="site-url-input" value={activeSiteId} disabled={isCrawling || isBulkDeleting}
              onChange={(event) => setActiveSiteId(event.target.value)}>
              {targetSites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
            {activeSiteId === 'nimi-tw-ranking' ? <select aria-label="NimiWiki 출처 필터" className="site-url-input"
              value={nimiSourceFilter} disabled={isBulkDeleting} onChange={(event) => setNimiSourceFilter(event.target.value as NimiPlatform | '')}>
              <option value="">전체 출처</option>
              {NIMI_PLATFORMS.map((platform) => <option key={platform} value={platform}>{NIMI_PLATFORM_LABELS[platform]}</option>)}
            </select> : null}
          </div>
          <details className="list-menu">
            <summary aria-label="목록 관리 메뉴">더보기</summary>
            <div className="list-menu-body">
              <button type="button" className="delete-button" disabled={!totalStoredItemCount || isCrawling || isBulkDeleting || !!pendingDeletion || !!deletingItemId}
                onClick={() => void handlePrepareDeleteAll()}>전체 사이트 항목 삭제</button>
            </div>
          </details>
        </div>

        <div className="bulk-actions">
          <span>선택 {selectedItemIds.size}건</span>
          <button type="button" className="site-url-reset" disabled={!visibleCount || isBulkDeleting || !!pendingDeletion}
            aria-label={activeSourceFilter ? '현재 출처 전체 선택' : '현재 사이트 전체 선택'} onClick={() => void handleSelectSiteItems()}>전체 선택</button>
          <button type="button" className="text-button" disabled={!selectedItemIds.size || isBulkDeleting || !!pendingDeletion}
            onClick={() => setSelectedItemIds(new Set())}>선택 해제</button>
          <button type="button" className="delete-button" disabled={!selectedItemIds.size || isCrawling || isBulkDeleting || !!pendingDeletion || !!deletingItemId}
            onClick={() => setPendingDeletion({ ids: [...selectedItemIds], scope: '선택한 항목' })}>선택 삭제</button>
        </div>

        <ul className="item-list">{renderedItems}</ul>
        <div className="list-footer">
          <span>{visibleCount > items.length ? `${items.length} / ${visibleCount}건 표시` : `전체 저장: ${totalStoredItemCount}건`}</span>
          <button type="button" className="text-button" disabled={isCrawling || isBulkDeleting}
            onClick={() => void handleOpenSite(activeSiteId)}>이 사이트 수집</button>
        </div>
      </section>
      </div>

      <footer className="workflow-footer">
        {status.kind !== 'idle' && step === 'list' ? (
          <details className="status-disclosure">
            <summary><span className={`status-line status-${status.kind}`} role="status" aria-live="polite">
              <span className="status-label">{STATUS_LABEL_BY_KIND[status.kind]}</span>
              <span className="status-preview">{status.message}</span>
            </span></summary>
            <p>{status.message}</p>
          </details>
        ) : status.kind !== 'idle' ? (
          <p className={`status-line status-${status.kind}`} role="status" aria-live="polite">
            <span className="status-label">{STATUS_LABEL_BY_KIND[status.kind]}</span><span>{status.message}</span>
          </p>
        ) : null}
        {isCrawling && autoCrawlRef.current ? (
          <button type="button" className="crawl-button crawl-stop" disabled={isStoppingCrawl}
            onClick={() => { setIsStoppingCrawl(true); autoCrawlRef.current?.abort() }}>
            {isStoppingCrawl ? '현재 페이지 처리 후 중지 중...' : '자동 수집 중지'}
          </button>
        ) : null}
        {step === 'target' ? (
          <button type="button" className="crawl-button" disabled={isCrawling || isBulkDeleting}
            onClick={() => void handleOpenSite(activeSiteId)}>사이트 열고 다음</button>
        ) : step === 'crawl' ? (
          <div className="step-actions">
            <button type="button" className="crawl-button" disabled={isCrawling || isBulkDeleting || !!pendingDeletion}
              onClick={() => void handleCrawl()}>{isCrawling ? '크롤링 중...' : '지금 크롤 실행'}</button>
            <button type="button" className="site-url-reset" onClick={() => setStep('list')}>저장 목록 보기</button>
          </div>
        ) : null}
      </footer>
      {pendingDeletion ? (
        <dialog className="delete-dialog" aria-labelledby="bulk-delete-title"
          ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal() }}
          onCancel={(event) => {
            if (isBulkDeleting) event.preventDefault()
            else setPendingDeletion(null)
          }}>
          <h2 id="bulk-delete-title">일괄 삭제 확인</h2>
          <p>{pendingDeletion.scope} {pendingDeletion.ids.length}건을 삭제합니다. 이 작업은 되돌릴 수 없습니다.</p>
          <p>수집 기록은 유지되므로 다시 크롤해도 삭제한 항목은 자동으로 복원되지 않습니다.</p>
          <div className="bulk-actions">
            <button type="button" className="site-url-reset" autoFocus disabled={isBulkDeleting}
              onClick={() => setPendingDeletion(null)}>취소</button>
            <button type="button" className="delete-button" disabled={isBulkDeleting}
              onClick={() => void handleBulkDelete()}>{isBulkDeleting ? '삭제 중...' : `${pendingDeletion.ids.length}건 삭제`}</button>
          </div>
        </dialog>
      ) : null}
    </main>
  )
}

export default App
