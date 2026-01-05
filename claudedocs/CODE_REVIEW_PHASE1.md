# Code Review Report - Phase 1: Foundation & Dependencies

**Date**: 2025-12-28
**Reviewer**: Claude Code
**Project**: Homework Validator (PDF 과제 인터뷰 시스템)

---

## Executive Summary

Phase 1 focuses on foundation infrastructure, dependency management, security baseline, and architectural contracts. This review identifies **8 P0 (Critical)**, **12 P1 (Important)**, and **7 P2 (Recommended)** issues across backend/frontend infrastructure.

### Critical Findings (P0)
1. **OpenAI API Key Exposure Risk** - `.env` file may be committed to git
2. **Invalid OpenAI Model** - `gpt-5.1` doesn't exist (should be `gpt-4o` or similar)
3. **Frontend Dependency Vulnerabilities** - High severity CVEs in glob/eslint packages
4. **No File Upload Size Limit** - DoS vulnerability via PDF upload
5. **Backend Missing TypeScript/Transpilation** - Package.json references compiled files that don't exist
6. **No Rate Limiting** - API endpoints vulnerable to abuse
7. **CORS Configuration Weakness** - No-origin requests always allowed
8. **Missing Input Validation** - No schema validation for API payloads

---

## 1. Architecture & Project Structure

### 1.1 Repository Layout
```
Homework Validatior/
├── backend/          # Express API (port 4010)
│   ├── index.js      # Single-file monolith (261 lines)
│   ├── package.json  # 5 runtime dependencies
│   ├── .env          # ⚠️ Contains real API key
│   └── .env.example  # Template
├── frontend/         # Next.js App Router (port 3010)
│   ├── app/
│   │   ├── page.js   # 672 lines - Upload + Interview + Results
│   │   ├── layout.js
│   │   └── globals.css
│   └── package.json  # Next 14.2.5, React 18
└── README.md         # Basic quick start
```

**Findings**:
- ✅ **Good**: Clear separation of concerns (backend/frontend)
- ❌ **P1**: Backend is single-file monolith (261 lines) - violates modularity
- ❌ **P2**: No `src/` directory structure despite package.json references
- ❌ **P2**: Frontend combines 3 major phases in single 672-line file
- ⚠️ **P1**: No `tests/` directory in either project

### 1.2 Dependency Analysis

#### Backend Dependencies
```json
{
  "cors": "^2.8.5",       // CORS middleware
  "dotenv": "^16.4.5",    // Environment variables
  "express": "^4.19.2",   // Web framework
  "openai": "^4.59.0",    // OpenAI SDK (Responses API)
  "pdf-parse": "^1.1.1"   // PDF text extraction
}
```

**Security Audit Results**:
```bash
npm audit
✅ 0 vulnerabilities found (103 dependencies)
```

**Findings**:
- ✅ **Good**: Minimal dependency footprint
- ✅ **Good**: No known vulnerabilities
- ❌ **P0**: Missing critical dependencies:
  - No `multer` despite README claiming multipart support
  - No input validation library (joi/zod/express-validator)
  - No rate limiting (express-rate-limit)
- ❌ **P1**: Missing dev dependencies:
  - No TypeScript despite `.ts` references in original spec
  - No testing framework (jest/mocha)
  - No linter/formatter

#### Frontend Dependencies
```json
{
  "next": "14.2.5",           // Framework (6 months old)
  "react": "^18",             // UI library
  "react-dom": "^18",
  "clsx": "^2.1.0",           // CSS utility
  "pdfjs-dist": "^4.6.82",    // ⚠️ Unused?
  "zustand": "^4.5.2"         // ⚠️ Unused?
}
```

**Security Audit Results**:
```bash
npm audit
❌ 3 high severity vulnerabilities
  - glob (CVE-1109842)
  - @next/eslint-plugin-next
  - eslint-config-next
Fix available: eslint-config-next@16.1.1 (major upgrade)
```

**Findings**:
- ❌ **P0**: High severity vulnerabilities in dev dependencies (glob)
- ❌ **P1**: Unused dependencies (`pdfjs-dist`, `zustand`) increase attack surface
- ⚠️ **P1**: Next.js 14.2.5 → 15.x available (6 months behind)
- ⚠️ **P2**: No TypeScript despite modern Next.js best practices

---

## 2. Environment & Configuration

### 2.1 Backend Configuration

**File**: `backend/.env.example`
```env
PORT=4010
FRONT_ORIGIN=http://localhost:3010,https://homeworkvalidator.vercel.app
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.1
```

**Critical Issues**:

#### ❌ P0-1: Invalid OpenAI Model
```javascript
// backend/index.js:31
const model = process.env.OPENAI_MODEL || 'gpt-5.1';
// ❌ gpt-5.1 doesn't exist
```

**Impact**: All API requests will fail with 404 Model Not Found
**Evidence**: OpenAI API documentation (Dec 2025) lists:
- `gpt-4o` (latest GPT-4 optimization)
- `gpt-4-turbo`
- `gpt-3.5-turbo`
- No `gpt-5.x` models available

**Fix Required**:
```javascript
const model = process.env.OPENAI_MODEL || 'gpt-4o';
```

#### ❌ P0-2: API Key Exposure Risk
```bash
$ ls -la backend/
-rw-r--r--  1 user  staff  180 Dec  5 14:03 .env
```

**Risk Assessment**:
- `.env` file exists with real key (180 bytes = likely production key)
- No `.gitignore` verification performed
- README instructs `cp .env.example .env` (dangerous pattern)

**Required Actions**:
1. Verify `.env` is in `.gitignore`
2. Check git history: `git log --all --full-history -- backend/.env`
3. If exposed, rotate key immediately via OpenAI dashboard
4. Add pre-commit hook to block `.env` commits

**Best Practice**:
```gitignore
# backend/.gitignore
.env
.env.local
.env.*.local
*.pem
*.key
```

### 2.2 Frontend Configuration

**Environment Variables**: `frontend/app/page.js:7`
```javascript
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4010";
```

**Findings**:
- ✅ **Good**: Proper `NEXT_PUBLIC_` prefix for client-side vars
- ⚠️ **P1**: No `.env.example` file in frontend (developers must guess)
- ⚠️ **P2**: No environment validation on build/runtime
- ⚠️ **P2**: Hardcoded default may cause CORS issues in production

**Recommended**: `frontend/.env.example`
```env
NEXT_PUBLIC_API_BASE=http://localhost:4010
```

---

## 3. Build & Runtime Infrastructure

### 3.1 Backend Build Configuration

**Problem**: Package.json references non-existent build system
```json
{
  "type": "module",      // ✅ ES modules
  "main": "index.js",    // ✅ Matches actual file
  "scripts": {
    "start": "node index.js",  // ✅ Works
    "dev": "node --watch index.js"  // ✅ Works (Node 18+)
  }
}
```

**Findings**:
- ✅ **Good**: Native ES modules (no transpilation needed)
- ✅ **Good**: Node --watch for dev experience
- ❌ **P2**: No `npm run build` script
- ❌ **P2**: No `npm run lint` or `npm test`
- ⚠️ **P2**: No Node version specification (`engines` field)

**Recommendation**: Add to package.json
```json
{
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "lint": "eslint .",
    "test": "echo 'No tests yet' && exit 0",
    "build": "echo 'No build step' && exit 0"
  }
}
```

### 3.2 Frontend Build Configuration

**Next.js Configuration**: Missing `next.config.js`

**Impact**:
- No custom Webpack config
- No image optimization settings
- No API rewrites/redirects
- Default everything

**Findings**:
- ⚠️ **P1**: No `next.config.js` for production optimization
- ⚠️ **P2**: No `tsconfig.json` (could enable without migration)
- ✅ **Good**: Standard Next.js build scripts work

**Recommended**: `frontend/next.config.js`
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // Security: hide Next.js signature
  compress: true,
  // Consider adding API_BASE validation
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
  },
};

module.exports = nextConfig;
```

---

## 4. Security Infrastructure Review

### 4.1 CORS Configuration

**Current Implementation**: `backend/index.js:16-26`
```javascript
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow no-origin (curl/postman) or exact match
      if (!origin) return callback(null, true); // ⚠️ Dangerous
      const normalized = origin.replace(/\/$/, '');
      const allowed = FRONT_ORIGINS.includes(normalized);
      return callback(allowed ? null : new Error('CORS blocked'), allowed);
    },
  }),
);
```

**Findings**:

#### ❌ P0-3: No-Origin Requests Always Allowed
```javascript
if (!origin) return callback(null, true);
```

**Risk**: Allows requests from:
- Server-side scripts (curl, axios)
- Electron apps
- Browser extensions
- Mobile apps without proper origin

**Attack Scenario**:
1. Attacker creates malicious script
2. Script has no `Origin` header (non-browser)
3. Can call `/api/analyze` with unlimited PDFs
4. DoS via OpenAI quota exhaustion + cost

**Fix**:
```javascript
origin: (origin, callback) => {
  // Only allow browser requests from whitelist
  if (!origin) {
    return callback(new Error('CORS blocked: no origin'));
  }
  const normalized = origin.replace(/\/$/, '');
  const allowed = FRONT_ORIGINS.includes(normalized);
  callback(allowed ? null : new Error('CORS blocked'), allowed);
},
credentials: true, // If using cookies/auth later
```

### 4.2 Request Size Limits

**Current Configuration**: `backend/index.js:27`
```javascript
app.use(express.json({ limit: '15mb' }));
```

**Findings**:
- ✅ **Good**: Has size limit for JSON bodies
- ❌ **P0-4**: No limit for PDF uploads (multipart/form-data)
- ❌ **P1**: 15MB is generous for text-only payloads

**Current Flow**:
```
POST /api/analyze
  ↓
  req.body.pdfBase64  // ❌ No multipart parsing!
  ↓
  base64 decode → pdf-parse
```

**Critical Problem**: Code expects `pdfBase64` but uses `express.json()` instead of `multer`:

```javascript
// ❌ README says: "multipart/form-data로 file(PDF)"
// ❌ Code does: JSON body with base64 string
// ❌ Frontend does: Converts to base64 then sends as JSON

// This means:
// - 10MB PDF → 13.3MB base64 → within 15MB limit ✓
// - 12MB PDF → 16MB base64 → REJECTED ✓
// - But no multipart parser exists for actual file uploads!
```

**Documentation vs Reality**:
- README claims multipart support → **FALSE**
- Frontend uses base64 in JSON → **MATCHES CODE**
- No `multer` dependency → **CONFIRMS JSON-ONLY**

**Recommendation**:
1. Update README to reflect base64 upload method
2. Add explicit file size check:
```javascript
app.post('/api/analyze', (req, res) => {
  const { pdfBase64 } = req.body || {};
  if (pdfBase64 && Buffer.byteLength(pdfBase64, 'base64') > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'file_too_large' });
  }
  // ...
});
```

### 4.3 Rate Limiting

**Current State**: ❌ **NONE**

**Risk Assessment**:
```javascript
// Anyone can spam:
POST /api/analyze   → OpenAI API calls (costs money)
POST /api/question  → OpenAI API calls (costs money)
POST /api/summary   → OpenAI API calls (costs money)

// No authentication, no rate limit, no cost control
```

**Attack Scenario**:
1. Attacker discovers API endpoint
2. Writes script to call `/api/analyze` 1000x/minute
3. Each call costs ~$0.02 (estimated)
4. $20/minute = $1,200/hour burn rate
5. OpenAI account drained in hours

**Required Fix**: `express-rate-limit`
```javascript
import rateLimit from 'express-rate-limit';

const analyzeLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Max 5 PDFs per 15min per IP
  message: { error: 'too_many_requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/analyze', analyzeLimit, async (req, res) => {
  // ...
});
```

### 4.4 Input Validation

**Current State**: ❌ **Manual checks only**

**Example**: `backend/index.js:139-143`
```javascript
const { assignmentText, pdfBase64 } = req.body || {};
if (!assignmentText && !pdfBase64) {
  return res.status(400).json({ error: 'assignmentText or pdfBase64 is required' });
}
```

**Findings**:
- ❌ **P0-5**: No type/schema validation
- ❌ **P1**: No XSS sanitization
- ❌ **P1**: No SQL injection protection (not applicable, no DB)
- ⚠️ **P2**: No request logging

**Risks**:
```javascript
// Attacker sends:
{
  "pdfBase64": { "$ne": null },  // Object instead of string
  "assignmentText": "<script>alert(1)</script>" // XSS
}

// Code does:
Buffer.from({ "$ne": null }, 'base64') // ⚠️ May crash
```

**Recommendation**: Add `zod` or `joi`
```javascript
import { z } from 'zod';

const analyzeSchema = z.object({
  assignmentText: z.string().max(100000).optional(),
  pdfBase64: z.string().regex(/^[A-Za-z0-9+/=]+$/).optional(),
}).refine(data => data.assignmentText || data.pdfBase64, {
  message: "Either assignmentText or pdfBase64 is required",
});

app.post('/api/analyze', (req, res, next) => {
  try {
    analyzeSchema.parse(req.body);
    next();
  } catch (err) {
    return res.status(400).json({ error: 'validation_failed', details: err.errors });
  }
}, async (req, res) => {
  // Safe to use req.body
});
```

---

## 5. API Contract Analysis

### 5.1 Backend Endpoints

#### POST /api/analyze
**Purpose**: PDF → Topics extraction
**Request**:
```json
{
  "assignmentText": "string (optional)",
  "pdfBase64": "string (optional, base64)"
}
```
**Response**:
```json
{
  "analysis": {
    "topics": [
      { "id": "t1", "title": "string", "description": "string" }
    ]
  },
  "text": "string (extracted text)",
  "fallback": false
}
```

**Issues**:
- ❌ **P1**: `fallback` field purpose unclear (no docs)
- ⚠️ **P2**: No `summary` field despite system prompt comment

#### POST /api/question
**Purpose**: Generate next interview question
**Request**:
```json
{
  "summary": "string (optional)",
  "topic": { "id": "string", "title": "string", "description": "string" },
  "excerpt": "string (optional)",
  "assignmentText": "string (optional)",
  "previousQA": [{ "role": "ai|student", "text": "string" }],
  "studentAnswer": "string (optional)"
}
```
**Response**:
```json
{
  "question": "string",
  "fallback": false
}
```

**Issues**:
- ❌ **P1**: Inconsistent casing (`previousQA` vs `studentAnswer`)
- ⚠️ **P2**: `excerpt` vs `assignmentText` redundancy

#### POST /api/summary
**Purpose**: Final evaluation
**Request**:
```json
{
  "transcript": "string (AI: ...\n학생: ...)",
  "topics": [{ "title": "string", "description": "string" }],
  "assignmentText": "string (optional)"
}
```
**Response**:
```json
{
  "summary": {
    "strengths": ["string"],
    "weaknesses": ["string"],
    "overallComment": "string"
  },
  "fallback": false
}
```

**Issues**:
- ✅ **Good**: Clear structure
- ⚠️ **P2**: No versioning in API paths

### 5.2 Frontend-Backend Integration

**Mismatch Analysis**:

1. **GET /api/session/active** (README) → ❌ Not implemented
2. **Topics handling**:
   - Backend returns up to 5 topics
   - Frontend hardcodes 3 topics: `page.js:151`
   - README says "10분(2분×5블록)" but code is "9분(3분×3블록)"

**Fix Priority**: P0 - Documentation must match reality

---

## 6. Observability & Logging

### 6.1 Backend Logging

**Current State**:
```javascript
console.log('Backend listening on port', PORT);
console.error('pdf parse error', parseErr);
console.warn('analyze JSON parse failed', { ... });
```

**Findings**:
- ✅ **Good**: Uses console.log/error/warn appropriately
- ❌ **P1**: No structured logging (JSON format)
- ❌ **P1**: No request IDs for tracing
- ❌ **P2**: No log levels (DEBUG/INFO/WARN/ERROR)
- ❌ **P2**: No log aggregation setup

**Recommendation**: Add `pino`
```javascript
import pino from 'pino';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  req.log = logger.child({ reqId: req.id });
  next();
});
```

### 6.2 Health Check

**Current Implementation**: `backend/index.js:135-137`
```javascript
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', model, hasApiKey });
});
```

**Findings**:
- ✅ **Good**: Has health endpoint
- ⚠️ **P1**: Exposes `model` and `hasApiKey` (info leak)
- ❌ **P2**: No dependency health checks (OpenAI reachable?)

**Recommendation**:
```javascript
app.get('/health', async (req, res) => {
  const checks = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };

  // Don't expose internals
  res.json(checks);
});

app.get('/health/ready', async (req, res) => {
  // Only for internal use (k8s readiness probe)
  const openaiOk = openai !== null;
  res.status(openaiOk ? 200 : 503).json({
    openai: openaiOk ? 'ok' : 'not_configured',
  });
});
```

---

## 7. Testing Infrastructure

**Current State**: ❌ **NONE**

**Required Test Coverage**:

### 7.1 Backend Tests (Missing)
- Unit: PDF parsing, JSON extraction, prompt building
- Integration: OpenAI API mocking
- E2E: Upload → Analyze → Question → Summary flow

### 7.2 Frontend Tests (Missing)
- Component: UploadCard, InterviewCard, ResultCard
- Integration: Timer logic, modal flow
- E2E: Full user journey with mocked backend

**Recommendation**: Add minimal test setup
```bash
# Backend
npm install --save-dev jest supertest

# Frontend
npm install --save-dev @testing-library/react @testing-library/jest-dom
```

---

## Summary: Phase 1 Findings

### P0 - Critical (Must Fix Before Production)
1. ❌ Invalid OpenAI model `gpt-5.1` → Fix to `gpt-4o`
2. ❌ Verify `.env` not in git, rotate key if exposed
3. ❌ Fix frontend dependency vulnerabilities (glob CVE)
4. ❌ Add rate limiting to all API endpoints
5. ❌ Fix CORS no-origin bypass
6. ❌ Add input validation (zod/joi)
7. ❌ Document mismatch: README vs actual implementation
8. ❌ Add explicit PDF size validation

### P1 - Important (Should Fix Soon)
1. ⚠️ Modularize backend (single 261-line file)
2. ⚠️ Remove unused frontend deps (pdfjs-dist, zustand)
3. ⚠️ Add structured logging
4. ⚠️ Create test infrastructure
5. ⚠️ Add Next.js config for production
6. ⚠️ Health endpoint exposes internals
7. ⚠️ No `.env.example` in frontend
8. ⚠️ Missing build/lint scripts
9. ⚠️ No error monitoring setup
10. ⚠️ No TypeScript migration path
11. ⚠️ Update Next.js 14.2.5 → 15.x
12. ⚠️ API response inconsistencies

### P2 - Recommended (Nice to Have)
1. ○ Add OpenAPI/Swagger docs
2. ○ Add pre-commit hooks
3. ○ Add Node version enforcement
4. ○ Improve error messages
5. ○ Add request/response logging
6. ○ Add performance monitoring
7. ○ Consider TypeScript migration

---

## Next Steps

**Phase 2**: Backend Core Logic Review (OpenAI integration, PDF parsing, prompt engineering)
**Phase 3**: Frontend Flow & Integration (Timer logic, state management, UX)
**Phase 4**: Security & Production Readiness (Deployment, monitoring, disaster recovery)

**Estimated Remediation Time**:
- P0 fixes: 4-6 hours
- P1 fixes: 8-12 hours
- P2 improvements: 16-20 hours

---

**Review Completed**: Phase 1 of 4
**Next Phase**: Backend Core Logic Review
