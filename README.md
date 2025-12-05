# Homework Validator

Student-side MVP: PDF 과제 업로드 → AI 주제 분석 → 3개 주제 인터뷰(각 3분, 타이핑/AI 생성 상태별 타이머 제어) → 이해도 요약.

## Projects
- `backend/` – Express API (port 4010). Uses OpenAI Response API (`thinking: medium`). See `backend/README.md`.
- `frontend/` – Next.js App Router UI (port 3010). See `frontend/README.md`.

## Quick start
```bash
# backend
cd backend
cp .env.example .env  # set OPENAI_API_KEY
npm install
npm start

# frontend (new shell)
cd frontend
npm install
npm run dev  # http://localhost:3010
```
