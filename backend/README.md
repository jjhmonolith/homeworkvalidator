# Homework Validator Backend

Express API for the student-side MVP.

## Endpoints
- `POST /api/analyze` – body `{ assignmentText?: string, pdfBase64?: string }` → `{ analysis, text, fallback }`
- `POST /api/question` – body `{ summary, topic, excerpt, previousQA, studentAnswer }`
- `POST /api/summary` – body `{ transcript, summary, topics }`
- `GET /health`

## Running
```bash
npm install
npm start # listens on PORT (default 4010)
```

## Env
- `PORT` (default 4010)
- `FRONT_ORIGIN` (default http://localhost:3010)
- `OPENAI_API_KEY` – optional; without it, fallback stub messages are returned
- `OPENAI_MODEL` – default gpt-4.1-mini (target gpt-5.1-mini)

PDF text is extracted server-side via `pdf-parse` when `pdfBase64` is provided.
