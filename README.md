# Maltlock Chrome Side Panel Crawler

React + TypeScript + Vite 기반 Chrome MV3 사이드패널 확장입니다.  
선택한 사이트 탭을 열고, 활성 탭 HTML을 수동 크롤링해 IndexedDB에 저장/조회합니다.

## 주요 기능
- 사이트 버튼 클릭으로 대상 탭 오픈 (`OPEN_TARGET_SITE`)
- 활성 탭 HTML 수집 후 사이트별 파서 실행 (`CRAWL_ACTIVE_TAB`)
- 파싱 결과를 로컬 IndexedDB(Dexie)에 upsert 저장
- 동일 아이템 중복 저장 방지 (정규화 URL + title 기반 해시 ID)
- 사이트별 최근 실행 기록(`success`/`partial`/`failed`) 표시
- 저장 아이템 단건 삭제
- 사생활 모드
  - 리스트 썸네일 숨김
  - 현재 웹페이지 탭에 블러 스타일 적용 (`SET_PRIVACY_SCREEN_BLUR`)
- 사이트별 URL 커스터마이즈 및 로컬 저장 (`localStorage`)

## 지원 사이트 (현재 UI 노출 기준)
- KissJAV: `https://kissjav.com/most-popular/?sort_by=video_viewed_week`
- MissAV: `https://missav123.to/ko/all?sort=weekly_views`
- TwiDouga: `https://www.twidouga.net/ko/ranking_t1.php`
- TorrentBot: `https://torrentbot230.site/topic/index?top=20`
- Kone: `https://kone.gg/s/pornvideo?mode=hot`
- Tcafe: `https://tcafe21.com/bbs/board.php?bo_table=D2001`

## 데이터 모델
### `items`
- `id`, `siteId`, `title`, `url`, `previewImageUrl`, `summary`, `price`, `rawHtmlSnippet`, `crawledAt`
- 인덱스: `id`, `siteId`, `crawledAt`, `[siteId+crawledAt]`

### `crawlRuns`
- `runId`, `siteId`, `startedAt`, `finishedAt`, `status`, `itemCount`, `errorCode`
- 인덱스: `runId`, `siteId`, `startedAt`, `finishedAt`, `status`, `[siteId+startedAt]`

## 기술 스택
- React 19
- TypeScript 5
- Vite 6 + `@crxjs/vite-plugin`
- Dexie + `dexie-react-hooks`
- Vitest
- Playwright (E2E)

## 개발 환경
```bash
pnpm install
```

## 실행/검증 명령어
```bash
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm test:watch
pnpm test:e2e
pnpm test:e2e:headed
```

## 로컬 설치 (Chrome)
1. `pnpm build`
2. `chrome://extensions` 이동
3. 우상단 개발자 모드 활성화
4. 압축해제된 확장 프로그램 로드
5. 프로젝트의 `dist` 폴더 선택
6. 확장 아이콘 클릭 시 사이드패널 열림

## E2E 테스트 (Playwright)
1. `pnpm exec playwright install chromium`
2. `pnpm test:e2e`

참고: 확장 로드 제약으로 E2E는 `headless: false`(headed)로 실행됩니다.

## 디렉터리 개요
```text
src/
  config/       # 타겟 사이트/매칭 규칙
  db/           # Dexie 스키마, 저장소 로직
  extension/    # manifest, service worker, content script, runtime client
  parsers/      # 사이트별 HTML 파서
  sidepanel/    # 실제 UI 엔트리 (sidepanel.html)
e2e/            # Playwright 확장 스모크 테스트
public/sample/  # 파서 개발용 샘플 HTML
```

## 문서
- 프로젝트 가이드: `docs/PROJECT_GUIDE.md`
- 바이브 코딩 가이드: `docs/VIBE_CODING_GUIDE.md`
