import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { targetSites } from '../config/targets'
import { listCrawlRunsBySite, listItemsBySite } from '../db/repository'
import { sendRuntimeRequest } from '../extension/runtime-client'
import type {
  CrawlErrorCode,
  CrawlSummary,
  OpenTargetSiteResult,
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

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(timestamp))
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
    case 'NO_ITEMS':
      return '수집 가능한 아이템이 없습니다.'
    case 'INVALID_REQUEST':
      return '요청 형식이 올바르지 않습니다.'
    default:
      return '알 수 없는 오류가 발생했습니다.'
  }
}

function App() {
  const defaultSiteId = targetSites[0]?.id ?? ''
  const [activeSiteId, setActiveSiteId] = useState(defaultSiteId)
  const [listSiteId, setListSiteId] = useState(defaultSiteId)
  const [status, setStatus] = useState<StatusState>(DEFAULT_STATUS)
  const [isCrawling, setIsCrawling] = useState(false)

  const activeSiteName = useMemo(() => {
    return targetSites.find((site) => site.id === activeSiteId)?.name ?? '-'
  }, [activeSiteId])

  const items = useLiveQuery(
    async () => {
      if (!listSiteId) {
        return []
      }

      return listItemsBySite(listSiteId, 200)
    },
    [listSiteId],
    [],
  )

  const latestRun = useLiveQuery(
    async () => {
      if (!listSiteId) {
        return null
      }

      const runs = await listCrawlRunsBySite(listSiteId, 1)
      return runs[0] ?? null
    },
    [listSiteId],
    null,
  )

  async function handleOpenSite(siteId: string): Promise<void> {
    const siteName = targetSites.find((site) => site.id === siteId)?.name ?? siteId
    setActiveSiteId(siteId)
    setListSiteId(siteId)

    const response = await sendRuntimeRequest<OpenTargetSiteResult>({
      type: 'OPEN_TARGET_SITE',
      payload: { siteId },
    })

    if (!response.ok) {
      setStatus({ kind: 'error', message: mapError(response.error.code) })
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
      payload: { siteId: activeSiteId },
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
        message: `${response.data.parsedCount}건 파싱, 저장 0건입니다. 필터 조건을 확인하세요.`,
      })
      return
    }

    setStatus({
      kind: 'success',
      message: `${response.data.parsedCount}건 파싱, ${response.data.storedCount}건 저장했습니다.`,
    })
  }

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
          {latestRun ? (
            <span className="run-meta">
              최근 실행: {formatDateTime(latestRun.finishedAt)} / 상태: {latestRun.status}
            </span>
          ) : (
            <span className="run-meta">실행 기록 없음</span>
          )}
        </div>

        <div className="tab-row" role="tablist" aria-label="사이트별 리스트 탭">
          {targetSites.map((site) => (
            <button
              key={site.id}
              type="button"
              role="tab"
              aria-selected={listSiteId === site.id}
              className={`tab-button ${listSiteId === site.id ? 'tab-active' : ''}`}
              onClick={() => {
                setListSiteId(site.id)
              }}
            >
              {site.name}
            </button>
          ))}
        </div>

        <ul className="item-list">
          {items.length === 0 ? (
            <li className="empty-row">아직 저장된 아이템이 없습니다.</li>
          ) : (
            items.map((item) => (
              <li key={item.id} className="item-row">
                <a href={item.url} target="_blank" rel="noreferrer" className="item-title">
                  {item.title}
                </a>
                <div className="item-meta">
                  <span>{formatDateTime(item.crawledAt)}</span>
                  {item.summary ? <span>{item.summary}</span> : null}
                </div>
              </li>
            ))
          )}
        </ul>
      </section>
    </main>
  )
}

export default App
