# Maltlock Chrome Side Panel Crawler

React + TypeScript + Vite 기반의 Chrome MV3 확장입니다.

## 구현 범위
- Side Panel UI
- 사이트 버튼 클릭 시 지정 URL 탭 오픈
- 수동 크롤 버튼으로 활성 탭 HTML 수집
- 사이트별 TS 파서로 아이템 생성
- IndexedDB(Dexie) 로컬 저장
- 사이트별 탭 리스트 표시

## 기술 스택
- React 19
- TypeScript
- Vite 6 + @crxjs/vite-plugin
- Dexie / dexie-react-hooks
- Vitest

## 개발 명령어
```bash
pnpm dev
pnpm build
pnpm lint
pnpm test
```

## 로컬 설치(Chrome)
1. `pnpm build`
2. Chrome에서 `chrome://extensions` 이동
3. 우상단 `개발자 모드` 활성화
4. `압축해제된 확장 프로그램을 로드합니다` 클릭
5. 프로젝트의 `dist` 폴더 선택
6. 확장 아이콘 클릭 -> 우측 Side Panel 열림

## 타겟 사이트
- KissJAV Weekly Popular (`https://kissjav.com/most-popular/?sort_by=video_viewed_week`)
- MissAV Weekly Views (`https://missav123.to/ko/all?sort=weekly_views`)
- TwiDouga Ranking T1 (`https://www.twidouga.net/ko/ranking_t1.php`)
- TorrentBot Topic Top20 (`https://torrentbot230.site/topic/index?top=20`)
- Kone Pornvideo Hot (`https://kone.gg/s/pornvideo?mode=hot`)

## 크롤링 추출 필드
- 제목 (`title`)
- 영상 URL (`url`)
- 미리보기 이미지 URL (`previewImageUrl`)

## 사생활 모드 참고
- 사생활 모드의 브라우저 화면 블러는 일반 웹페이지(`http/https`) 탭에서 동작합니다.
- 브라우저 내부 페이지(`chrome://`, 확장 스토어 등)는 보안 정책상 블러 적용이 제한됩니다.

## 문서
- 기획/개발 프로세스: `docs/PROJECT_GUIDE.md`
- 바이브 코딩 가이드: `docs/VIBE_CODING_GUIDE.md`
