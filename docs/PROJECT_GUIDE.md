# 프로젝트 기획 및 개발 프로세스

## 목표
- 클릭 시 Chrome Side Panel이 열리는 MV3 확장 구현
- 사이트별 수동 크롤 + 파싱 + 로컬 저장 + 탭 분리 리스트 제공

## 아키텍처
- `src/extension/service-worker.ts`: 메시지 라우팅, 탭 제어, 크롤 오케스트레이션
- `src/extension/content-script.ts`: 페이지 HTML 수집
- `src/sidepanel/App.tsx`: UI, 상태 표시, 탭/리스트 렌더
- `src/parsers/*.parser.ts`: 사이트별 파서
- `src/db/*`: Dexie 스키마/저장소

## 데이터 흐름
1. Side Panel에서 사이트 선택
2. `OPEN_TARGET_SITE` 메시지로 탭 오픈
3. `CRAWL_ACTIVE_TAB` 메시지로 활성 탭 크롤 시작
4. HTML 수집 -> 파서 실행 -> 중복 키 생성(`URL + titleHash`)
5. Dexie 저장 및 사이트별 리스트 조회

## 오류 코드 정책
- `TAB_NOT_FOUND`
- `TAB_URL_MISMATCH`
- `CONTENT_SCRIPT_UNAVAILABLE`
- `PARSE_FAILED`
- `NO_ITEMS`

## 테스트 전략
- 유닛 테스트: 파서, 중복 키, 저장소 업서트
- 수동 QA: 사이트 오픈/크롤/저장/탭 전환/오류 시나리오

## 수동 QA 체크리스트
1. 사이트 버튼 클릭 시 정확한 URL 탭이 열린다.
2. 활성 탭 URL이 사이트와 일치할 때만 크롤 성공한다.
3. 같은 아이템 재크롤 시 중복 증가 없이 갱신된다.
4. 사이트 탭별로 데이터가 분리되어 보인다.
5. 브라우저 재시작 후 기존 데이터가 유지된다.
6. 오류 코드별 메시지가 구분되어 표시된다.
