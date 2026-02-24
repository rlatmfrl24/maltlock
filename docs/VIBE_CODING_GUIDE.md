# 바이브 코딩 가이드 (프롬프트 템플릿 중심)

## 작업 단위 원칙
- 한 번에 파일 1~3개, 기능 1개만 요청
- 항상 타입/오류 처리/테스트를 함께 요청
- 생성 직후 빌드/테스트 결과를 반드시 확인

## 기본 프롬프트 템플릿
1. 타입 계약
- `src/types/contracts.ts`에 메시지 타입만 정의해줘. `OPEN_TARGET_SITE`, `CRAWL_ACTIVE_TAB`, `CRAWL_RESULT`, `CRAWL_ERROR`와 응답 타입까지.

2. 파서 구현
- `src/parsers/<site>.parser.ts` 구현해줘. 입력은 `html`, `pageUrl`, 출력은 `ParsedItem[]`. 파싱 실패 시 throw하지 말고 빈 배열을 반환해.

3. 저장소 구현
- `src/db/repository.ts`에 `upsertCrawledItems`, `listItemsBySite` 구현해줘. 중복키는 URL+title 해시를 사용해.

4. 서비스워커 구현
- `src/extension/service-worker.ts`에서 `OPEN_TARGET_SITE`와 `CRAWL_ACTIVE_TAB` 핸들러 구현해줘. `TAB_NOT_FOUND`, `TAB_URL_MISMATCH`, `PARSE_FAILED` 분기 포함.

5. 테스트 생성
- 위 변경에 대해 vitest 테스트를 만들어줘. 정상/오류/중복 케이스를 포함해.

## 검증 루프 프롬프트
- "타입 오류 가능성을 점검해줘."
- "권한 누락(host_permissions, tabs, scripting)을 점검해줘."
- "실패 경로에서 사용자 메시지가 누락된 부분을 찾아줘."

## 리뷰 프롬프트
- "MV3 정책 위반 가능성과 과도한 권한 요청만 집중 리뷰해줘."
- "XSS/민감 데이터 저장 위험만 집중 리뷰해줘."

## 금지 패턴
- "전부 한 번에 만들어줘"
- "테스트는 나중에"
- "에러 처리 없이 빠르게"
