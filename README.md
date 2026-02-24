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
- Hacker News (`https://news.ycombinator.com/*`)
- DEV.to Latest (`https://dev.to/*`)

## 문서
- 기획/개발 프로세스: `docs/PROJECT_GUIDE.md`
- 바이브 코딩 가이드: `docs/VIBE_CODING_GUIDE.md`
