import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { targetSites } from '../config/targets'
import {
  deleteCrawledItem,
  listCrawlRunsBySite,
  listItemsBySite,
} from '../db/repository'
import { sendRuntimeRequest } from '../extension/runtime-client'
import type {
  CrawledItem,
  CrawlErrorCode,
  CrawlSummary,
  OpenTargetSiteResult,
  SetPrivacyScreenBlurResult,
} from '../types/contracts'

type StatusKind = 'idle' | 'loading' | 'success' | 'warning' | 'error'

interface StatusState {
  kind: StatusKind
  message: string
}

const DEFAULT_STATUS: StatusState = {
  kind: 'idle',
  message: '대상 사이트를 열고 활성 탭에서 크롤 버튼을 눌러주세요.',
}

const PRIVACY_MODE_STORAGE_KEY = 'maltlock:privacy-mode'
const SITE_URL_STORAGE_KEY = 'maltlock:site-urls'
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'short',
  timeStyle: 'medium',
})
const TARGET_SITE_BY_ID = new Map(targetSites.map((site) => [site.id, site]))

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
    item.siteId === 'twidouga-ranking-t1' &&
    item.summary &&
    /^https?:\/\//i.test(item.summary)
  ) {
    return item.summary
  }

  return item.url
}

function App() {
  const defaultSiteId = targetSites[0]?.id ?? ''
  const [activeSiteId, setActiveSiteId] = useState(defaultSiteId)
  const [siteUrls, setSiteUrls] = useState<Record<string, string>>(getInitialSiteUrls)
  const [status, setStatus] = useState<StatusState>(DEFAULT_STATUS)
  const [isCrawling, setIsCrawling] = useState(false)
  const [isPrivacyMode, setIsPrivacyMode] = useState(getInitialPrivacyMode)
  const [isTogglingPrivacyMode, setIsTogglingPrivacyMode] = useState(false)
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null)
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

  const items = useLiveQuery(
    async () => {
      if (!activeSiteId) {
        return []
      }

      return listItemsBySite(activeSiteId, 200)
    },
    [activeSiteId],
    [],
  )

  const latestRun = useLiveQuery(
    async () => {
      if (!activeSiteId) {
        return null
      }

      const runs = await listCrawlRunsBySite(activeSiteId, 1)
      return runs[0] ?? null
    },
    [activeSiteId],
    null,
  )

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
      message: `${siteName} 탭을 열었습니다.`,
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
        message:
          response.data.updatedCount > 0
            ? `${response.data.parsedCount}건 파싱, 신규 저장 0건 / 기존 ${response.data.updatedCount}건 업데이트했습니다.`
            : `${response.data.parsedCount}건 파싱, 신규 저장 0건입니다. 필터 조건을 확인하세요.`,
      })
      return
    }

    setStatus({
      kind: 'success',
      message:
        response.data.updatedCount > 0
          ? `${response.data.parsedCount}건 파싱, 신규 ${response.data.storedCount}건 저장 / 기존 ${response.data.updatedCount}건 업데이트했습니다.`
          : `${response.data.parsedCount}건 파싱, 신규 ${response.data.storedCount}건 저장했습니다.`,
    })
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
      return <li className="empty-row">아직 저장된 아이템이 없습니다.</li>
    }

    return items.map((item) => (
      <li key={item.id} className="item-row">
        <div className={`item-main ${isPrivacyMode ? 'item-main-privacy' : ''}`}>
          {!isPrivacyMode ? (
            item.previewImageUrl ? (
              <img
                src={item.previewImageUrl}
                alt={item.title}
                className="item-preview"
                loading="lazy"
              />
            ) : (
              <div className="item-preview item-preview-empty">No Image</div>
            )
          ) : null}
          <div className="item-content">
            <a
              href={getTitleLinkUrl(item)}
              target="_blank"
              rel="noreferrer"
              className="item-title"
            >
              {item.title}
            </a>
            <a href={item.url} target="_blank" rel="noreferrer" className="item-url">
              {item.url}
            </a>
            <div className="item-meta">
              <span>{formatDateTime(item.crawledAt)}</span>
              {item.summary ? <span>{item.summary}</span> : null}
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
      </li>
    ))
  }, [deletingItemId, handleDeleteItem, isPrivacyMode, items])

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <h1>Maltlock Crawler</h1>
        <p>선택 사이트: {activeSiteName}</p>
      </header>

      <section className="section-block">
        <h2>대상 사이트</h2>
        <div className="site-grid">
          {targetSites.map((site) => (
            <button
              key={site.id}
              type="button"
              className={`chip ${activeSiteId === site.id ? 'chip-active' : ''}`}
              onClick={() => {
                void handleOpenSite(site.id)
              }}
            >
              {site.name}
            </button>
          ))}
        </div>
        {activeSite ? (
          <div className="site-url-editor">
            <label className="site-url-label" htmlFor="site-url-input">
              {activeSite.name} URL
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
        <h2>크롤 실행</h2>
        <button
          type="button"
          className="crawl-button"
          onClick={() => {
            void handleCrawl()
          }}
          disabled={isCrawling}
        >
          {isCrawling ? '크롤링 중...' : '크롤'}
        </button>
        <p className={`status-line status-${status.kind}`}>{status.message}</p>
      </section>

      <section className="section-block list-block">
        <div className="list-header">
          <h2>저장 리스트</h2>
          <div className="list-controls">
            <button
              type="button"
              className={`privacy-toggle ${isPrivacyMode ? 'privacy-toggle-on' : ''}`}
              onClick={() => {
                void handleTogglePrivacyMode()
              }}
              disabled={isTogglingPrivacyMode}
            >
              {isTogglingPrivacyMode
                ? '사생활 모드 적용 중...'
                : `사생활 모드 ${isPrivacyMode ? 'ON' : 'OFF'}`}
            </button>
            {latestRun ? (
              <span className="run-meta">
                최근 실행: {formatDateTime(latestRun.finishedAt)} / 상태: {latestRun.status}
              </span>
            ) : (
              <span className="run-meta">실행 기록 없음</span>
            )}
          </div>
        </div>

        <ul className="item-list">{renderedItems}</ul>
      </section>
    </main>
  )
}

export default App
