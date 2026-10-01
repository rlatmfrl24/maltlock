# Maltlock Chrome Side Panel Crawler

React + TypeScript + Vite 기반 Chrome MV3 사이드패널 확장입니다.  
선택한 사이트로 현재 활성 탭을 이동하고, 활성 탭 HTML을 수동·자동 크롤링해 IndexedDB에 저장/조회합니다.

## 주요 기능
- 사이트 버튼 클릭으로 현재 탭을 대상 사이트로 이동 (`OPEN_TARGET_SITE`)
- 활성 탭 HTML 수집 후 사이트별 파서 실행 (`CRAWL_ACTIVE_TAB`)
- 코네 인기글 지정 페이지 범위 자동 순회, 페이지별 저장, 진행 건수 표시와 중지
- TwiDouga 24시간 랭킹의 1–20위 자동 수집
- KissJAV·123AV 지정 페이지 범위 자동 수집 (기본 1–3페이지)
- 파싱 결과를 로컬 IndexedDB(Dexie)에 저장
- 기존 수집 로그 기반 중복 저장 방지 (아이템 ID별 `seen` 로그 유지)
- 사이트별 최근 10회 실행 기록과 파서 연속 실패 상태 표시
- fixture 기반 활성 파서 헬스체크 및 CI 검증
- 파서 실패 진단 JSON 내보내기와 선택적 원본 로컬 보관
- 저장 아이템 단건·선택·전체 사이트 일괄 삭제 (확인 후 삭제, 수집 로그 유지)
- 사생활 모드
  - 리스트 썸네일 숨김
  - 현재 웹페이지 탭에 블러 스타일 적용 (`SET_PRIVACY_SCREEN_BLUR`)
- 사이트별 URL 커스터마이즈 및 로컬 저장 (`localStorage`)

## 지원 사이트 (현재 UI 노출 기준)
- KissJAV: `https://kissjav.li/most-popular/?sort_by=video_viewed_week`
- 123AV: `https://123av.com/ko/all?sort=week`
- TwiDouga: `https://www.twidouga.net/ko/ranking_t1.php`
- NimiWiki: `https://video1.nimi.wiki/tw/ranking?sort=plays&period=week`
- Kone: `https://kone.gg/s/pornvideo?mode=hot`
- Tcafe: `https://tcafe21.com/bbs/board.php?bo_table=D2001`

## 코네 자동 수집
Kone 버튼으로 게시판을 연 뒤, **코네 수집 범위 → 인기글 페이지 범위 자동 수집**을 선택하고 시작·끝 페이지를 입력한 다음 **지금 크롤 실행**을 누릅니다.
기본 범위는 **1–5페이지**입니다. 시작·끝 페이지를 포함해 현재 필터의 지정 범위를 순회합니다. 끝 페이지를 비우면 마지막까지 수집하며, 신규가 없는 페이지도 계속 확인합니다.
수집 중에는 패널과 코네 탭을 열어 두세요. 중지·오류가 발생해도 이미 저장한 항목은 유지하며, 다시 실행하면 지정한 시작 페이지부터 재확인합니다.

## KissJAV·123AV 자동 수집
사이트를 연 뒤, **수집 범위 → 페이지 범위 자동 수집**을 선택하고 **지금 크롤 실행**을 누릅니다.
기본 범위는 **1–3페이지**이며 시작·끝 페이지를 변경할 수 있습니다. 두 사이트는 끝 페이지를 반드시 입력합니다.
현재 정렬을 유지하고 사이트의 다음 페이지 링크로 순회합니다. 신규가 없는 페이지도 확인하며, 페이지마다 저장하므로 중지·오류 시 이전 결과를 유지합니다.
KissJAV는 화면 내부의 페이지 버튼을 직접 클릭합니다. 주소가 바뀌지 않는 AJAX 이동도 목록 교체와 현재 페이지 번호를 확인한 뒤 수집하며, 시작 페이지로 돌아갈 때도 화면의 버튼을 사용합니다.
현재 `kissjav.li` 주소를 사용합니다. 저장된 `kissjav.com` 사이트 주소 설정은 필터와 경로를 유지하면서 새 주소로 갱신하며, 이전 도메인에서 수집한 동일 항목도 기존 중복 판정을 적용합니다.
123AV의 기존 품번 기준 중복 판정도 적용되므로, 동일 품번의 다른 버전 URL이 중복으로 제외될 수 있습니다.
기본 선택은 **현재 페이지**입니다. 자동 수집 중에는 패널과 대상 탭을 열어 두세요. 로그인·접속 제한 화면이 나오면 이를 해결한 뒤 다시 실행합니다.

## TwiDouga 자동 수집
TwiDouga 버튼으로 사이트를 연 뒤, **TwiDouga 수집 범위 → 1–20위 자동 수집**을 선택하고 **지금 크롤 실행**을 누릅니다.
1–10위를 저장하고 사이트의 **11~20위** 버튼 링크로 같은 탭을 이동해 수집합니다. 첫 페이지가 모두 중복이어도 두 번째 페이지를 확인합니다.
기본 선택은 **현재 페이지**입니다. 자동 수집은 한국어 24시간 랭킹에 적용하며, 중지·오류가 발생해도 이미 저장한 항목은 유지합니다.

## NimiWiki 자동 수집
기본 선택은 **4개 플랫폼 주간 인기 자동 수집**입니다. **지금 크롤 실행**을 누르면 같은 탭에서 트위터 → 인스타그램 → 틱톡 → 블루스카이의 조회수 기준 주간 목록을 차례로 수집합니다. **현재 목록 수집**을 선택하면 현재 플랫폼·정렬·기간을 사용합니다.

플랫폼별 결과는 바로 저장하며, 한 플랫폼에서 오류가 나도 다음 플랫폼을 확인합니다. 중지·수동 탭 이동 시에는 다음 이동을 멈춥니다. 페이지 확인과 API 요청은 각각 15초 제한을 적용합니다.

저장 목록의 출처 배지와 **NimiWiki 출처 필터**로 플랫폼을 구분할 수 있습니다. 필터의 **전체 선택**은 화면 표시 제한 밖의 해당 출처 항목도 포함하며, 선택은 필터를 바꿔도 유지됩니다.

## 항목 일괄 삭제
저장 목록에서 항목의 체크박스로 선택하거나 **전체 선택**을 누른 뒤 **선택 삭제**로 삭제 건수를 확인합니다. 목록 사이트를 바꿔도 선택은 유지됩니다.
**더보기 → 전체 사이트 항목 삭제**는 목록 표시 한도와 관계없이 모든 사이트의 저장 항목을 삭제합니다.
삭제는 되돌릴 수 없습니다. 수집 로그는 유지하므로 다시 크롤해도 삭제한 항목이 복원되지 않습니다.

## 단계별 화면
1. **대상 선택**: 사이트를 누르면 현재 탭에서 열고 수집 설정으로 이동합니다. 주소 변경은 사이트 주소 설정에서 합니다.
2. **수집 실행**: 범위를 설정하고 실행합니다. 정상 완료하면 신규 건수와 관계없이 저장 목록으로 자동 이동하며, 오류·일부 완료·중지 시에는 현재 화면을 유지합니다. 진행 상황과 중지 버튼은 다른 단계에서도 유지됩니다. 실행 진단은 펼쳐 확인합니다.
3. **저장 목록**: 저장된 항목을 묶지 않고 개별 행으로 표시하며, 목록에 남은 화면 높이를 사용합니다. 사이트 필터는 브라우저 탭을 이동하지 않으며, 선택 삭제와 사생활 모드를 지원합니다.

상단 단계 버튼으로 언제든 이동할 수 있고, 수집하지 않아도 저장 목록을 바로 열 수 있습니다. 목록의 실행 메시지를 누르면 상세 내용을 펼칩니다.

## 데이터 모델
### `items`
- `id`, `siteId`, `title`, `url`, `previewImageUrl`, `summary`, `price`, `rawHtmlSnippet`, `crawledAt`, 선택적 `sourcePlatform` (`tw`, `ig`, `tt`, `bs`)
- 인덱스: `id`, `siteId`, `crawledAt`, `[siteId+crawledAt]`

### `crawlRuns`
- `runId`, `siteId`, `startedAt`, `finishedAt`, `status`, `errorCode`
- 파싱/저장 지표: `parsedCount`, `validCount`, `insertedCount`, `duplicateCount`, `rejectedCount`
- 진단 정보: `stage`, `inputSource`, `inputBytes`, `inputHash`, `durationMs`, `warnings`
- 인덱스: `runId`, `siteId`, `startedAt`, `finishedAt`, `status`, `[siteId+startedAt]`

### `crawledItemLogs`
- `id(itemId)`, `siteId`, `itemId`, `firstSeenAt`, `lastSeenAt`, `seenCount`
- 인덱스: `id`, `siteId`, `itemId`, `firstSeenAt`, `lastSeenAt`, `seenCount`, `[siteId+lastSeenAt]`

### `crawlDiagnostics`
- 파서 실패 시 사용자가 원본 보관을 켠 경우에만 gzip 입력을 저장
- 사이트별 최근 3건, 최대 7일, 원본 2MiB 이하로 제한

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
pnpm test:parsers
pnpm check
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
src/test/fixtures/parsers/  # 파서 테스트용 HTML/JSON fixture
```

## 문서
- 프로젝트 가이드: `docs/PROJECT_GUIDE.md`
- 바이브 코딩 가이드: `docs/VIBE_CODING_GUIDE.md`
