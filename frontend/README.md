# Homework Validator (Frontend)

Next.js App Router UI for the AI 과제 인터뷰 MVP. No login, always starts from PDF 업로드 and resets on refresh.

## Quick start

```bash
npm install
npm run dev # runs on http://localhost:3010
```

Backend expected at `http://localhost:4010` by default. Override with `NEXT_PUBLIC_API_BASE`.

## Key flows
- PDF 업로드 → /api/analyze 호출 → 요약/주제 준비
- 인터뷰: 주제별 3분, 입력 중일 때만 타이머 차감. AI 생성 시 타이머 정지.
- 수동 종료 모달 동안에도 타이머 차감, 0초가 되면 자동 종료 모달로 전환(5초 후 다음 주제).
- 주제마다 새 채팅, 역방향 이동 불가. 3개 완료 후 /api/summary 호출.

## Scripts
- `npm run dev` – dev server on 3010
- `npm run build` – production build
- `npm run start` – start built app on 3010
- `npm run lint` – lint

## Environment
- `NEXT_PUBLIC_API_BASE` (optional) – default `http://localhost:4010`

