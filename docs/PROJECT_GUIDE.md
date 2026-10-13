# 프로젝트 기획 및 개발 프로세스

## 목표
- 클릭 시 Chrome Side Panel이 열리는 MV3 확장 구현
- 공통 사이트 선택 + 수집결과/크롤링 두 화면 + 시작 버튼으로 이동·파싱·로컬 저장·결과 표시

## 아키텍처
- `src/extension/service-worker.ts`: 메시지 라우팅, 탭 제어, 크롤 오케스트레이션
- `src/extension/content-script.ts`: 페이지 HTML 수집
- `src/sidepanel/App.tsx`: UI, 상태 표시, 탭/리스트 렌더
- `src/parsers/*.parser.ts`: 사이트별 파서
- `src/db/*`: Dexie 스키마/저장소

## 데이터 흐름
1. Side Panel에서 사이트 선택 (브라우저 이동 없이 결과 조회)
2. 크롤링 화면의 시작 버튼으로 `OPEN_TARGET_SITE` 요청, 새 문서 준비 확인 후 tabId/documentId 수신
3. 준비된 탭·문서를 지정해 `CRAWL_ACTIVE_TAB` 요청 또는 페이지/플랫폼 자동 순회
4. HTML/API 입력 수집 -> 입력 지문 기록 -> 파서 실행 -> 정규화/중복 분류
5. 신규 아이템만 Dexie 저장, 전체 유효 아이템은 로그(`seenCount`) 갱신
6. 단계별 파싱/유효/신규/중복/탈락 지표를 `crawlRuns`에 저장
7. 모든 종료 상태에서 수집결과 표시, 실행 요약과 실패 원인 안내

### 사이트 준비와 중지 계약
- `OPEN_TARGET_SITE`는 준비된 `tabId`, 최종 `url`, `documentId`를 반환합니다. 단일 수집과 자동 순회는 이 탭·문서를 사용합니다.
- UI는 준비 요청에 고유 `requestId`를 넣습니다. 준비 중 중지·시간 초과·패널 해제 시 `CANCEL_TARGET_SITE`로 확장 내부 대기까지 취소해 늦은 탭 이동을 막습니다.
- 자동 순회는 패널이 소유하며, 이미 시작한 페이지 저장은 완료한 뒤 다음 이동을 중지합니다.

## 오류 코드 정책
- `TAB_NOT_FOUND`
- `TAB_URL_MISMATCH`
- `CONTENT_SCRIPT_UNAVAILABLE`
- `PARSE_FAILED`
- `PARSE_EMPTY`
- `NORMALIZATION_EMPTY`
- `NO_ITEMS`는 과거 실행 기록 표시 호환용으로만 유지

## 테스트 전략
- 유닛 테스트: 파서 계약, 중복 키, 저장소 업서트, 실행 결과 판정, 진단 보존
- CI: push/PR마다 `pnpm check` 실행
- 수동 QA: 사이트 오픈/크롤/저장/탭 전환/오류 시나리오

## 수동 QA 체크리스트
1. 사이트 선택과 화면 탭 전환은 브라우저 URL을 바꾸지 않는다.
2. 크롤링 시작은 사이트 주소로 이동한 뒤 준비된 새 문서만 수집한다. 수동 이동을 덮어쓰지 않는다.
3. 같은 아이템 재크롤 시 중복 증가 없이 갱신된다.
4. 공통 사이트 선택에 따라 누적 결과가 분리되어 보인다. 실패·중지·중복만 있어도 결과 화면으로 돌아온다.
5. 브라우저 재시작 후 기존 데이터가 유지된다.
6. 오류 코드별 메시지가 구분되어 표시된다.
