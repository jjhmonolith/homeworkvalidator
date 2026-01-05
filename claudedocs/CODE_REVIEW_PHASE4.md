# Code Review Report - Phase 4: Security & Production Readiness

**Date**: 2025-12-28
**Reviewer**: Claude Code
**Focus**: Security Vulnerabilities, Production Deployment, Monitoring, Disaster Recovery

---

## Executive Summary

Phase 4 analyzes production readiness focusing on security hardening, deployment configuration, observability, and operational resilience. This review identifies **7 P0 (Critical)**, **10 P1 (Important)**, and **6 P2 (Recommended)** issues.

### Critical Findings (P0)
1. **No HTTPS Enforcement** - Credentials transmitted in plaintext
2. **No Security Headers** - Missing CSP, HSTS, X-Frame-Options
3. **No Environment Separation** - Dev/Prod use same configuration
4. **No Secrets Management** - API keys in plaintext .env files
5. **No Backup/Recovery** - Session data loss is permanent
6. **No Monitoring/Alerting** - Silent failures in production
7. **No Deployment Documentation** - Zero-docs deployment

---

## 1. Security Hardening

### 1.1 Transport Security

#### ❌ P0-33: No HTTPS Enforcement
```javascript
// backend/index.js - No HTTP→HTTPS redirect
// frontend - API_BASE can be http://

// Risk:
// - API keys transmitted in plaintext
// - Student answers intercepted
// - Session hijacking via MITM
```

**Fix**: Add HTTPS enforcement
```javascript
// backend/index.js
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      return res.redirect(`https://${req.header('host')}${req.url}`);
    }
    next();
  });
}
```

#### ❌ P0-34: Missing Security Headers
```javascript
// No helmet.js or manual security headers
// Missing:
// - Content-Security-Policy
// - Strict-Transport-Security
// - X-Content-Type-Options
// - X-Frame-Options
// - X-XSS-Protection
```

**Fix**:
```javascript
import helmet from 'helmet';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Next.js requires unsafe-inline
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", process.env.FRONT_ORIGIN],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
}));
```

### 1.2 Authentication & Authorization

#### ⚠️ P1-28: No Authentication System
```javascript
// Current: Anyone can call /api/analyze unlimited times
// No user accounts, no API keys, no tokens

// Risk:
// - Abuse via automation
// - Cost attack (OpenAI API usage)
// - No accountability
```

**Not a P0 because**: This is MVP scope, authentication out of scope per README

**Future Consideration**:
```javascript
// Options:
// 1. Anonymous rate-limited access (current)
// 2. Email-based session tokens
// 3. OAuth (Google/GitHub)
// 4. API key system for institutional use
```

#### ⚠️ P1-29: No CSRF Protection
```javascript
// API accepts POST requests without CSRF tokens
// If user is logged into other site, attacker can trigger requests

// Mitigated by:
// - CORS restrictions ✅
// - No cookies/sessions ✅
// - Stateless design ✅

// But vulnerable if cookies added later
```

**Fix** (if auth added):
```javascript
import csrf from 'csurf';
const csrfProtection = csrf({ cookie: true });
app.use(csrfProtection);
```

### 1.3 Data Sanitization

#### ❌ P0-16 (From Phase 2): Prompt Injection
```javascript
// Already identified in Phase 2
// Student input directly interpolated into prompts
// See Phase 2 for fix
```

#### ⚠️ P1-30: No HTML Sanitization in Frontend
```javascript
// frontend/app/page.js:561
<p>{turn.text}</p>

// If AI returns: <script>alert(1)</script>
// Browser renders as text (✅ Safe due to React's auto-escaping)

// BUT if using dangerouslySetInnerHTML anywhere:
// ❌ Would be XSS vulnerability
```

**Current Status**: ✅ Safe (React escapes by default)
**Recommendation**: Add explicit sanitizer if ever using `dangerouslySetInnerHTML`

### 1.4 Dependency Security

#### ✅ Backend Dependencies: Clean
```bash
npm audit (backend)
0 vulnerabilities
```

#### ❌ P0-3 (From Phase 1): Frontend Vulnerabilities
```bash
npm audit (frontend)
3 high severity vulnerabilities
- glob (CVE-1109842)
- eslint packages
```

**Fix**: Already documented in Phase 1
```bash
cd frontend
npm install eslint-config-next@16.1.1
npm audit fix
```

---

## 2. Environment Configuration

### 2.1 Environment Separation

#### ❌ P0-35: No Dev/Staging/Prod Separation
```javascript
// Single .env file for all environments
// No .env.development, .env.production

// Risk:
// - Accidentally use prod API key in dev
// - Test data pollutes production
// - No isolated testing environment
```

**Fix**: Create environment-specific configs
```bash
# backend/
.env.development
.env.staging
.env.production

# Usage:
NODE_ENV=production npm start
```

```javascript
// backend/.env.development
PORT=4010
OPENAI_API_KEY=sk-test-...
OPENAI_MODEL=gpt-4o
FRONT_ORIGIN=http://localhost:3010
LOG_LEVEL=debug

// backend/.env.production
PORT=4010
OPENAI_API_KEY=sk-prod-...
OPENAI_MODEL=gpt-4o
FRONT_ORIGIN=https://homeworkvalidator.vercel.app
LOG_LEVEL=info
RATE_LIMIT_MAX=5
RATE_LIMIT_WINDOW_MS=900000
```

#### ❌ P0-36: Secrets in Version Control Risk
```bash
# Current setup:
# 1. .env.example committed ✅
# 2. .env exists with real key ⚠️
# 3. No verification .env is gitignored

# Verify:
git ls-files | grep .env
# If returns "backend/.env" → CRITICAL LEAK
```

**Required Actions**:
1. Check git history:
```bash
git log --all --full-history -- "**/.env"
git log --all --full-history --grep="OPENAI_API_KEY"
```

2. If found, rotate all secrets immediately
3. Verify .gitignore:
```gitignore
# Root .gitignore
**/.env
**/.env.local
**/.env.*.local
!**/.env.example
```

### 2.2 Configuration Validation

#### ⚠️ P1-31: No Startup Configuration Check
```javascript
// backend/index.js starts without validating:
// - OPENAI_API_KEY exists
// - OPENAI_API_KEY format valid (sk-...)
// - FRONT_ORIGIN is valid URL
// - PORT is available

// Server starts "successfully" even if broken
```

**Fix**:
```javascript
// config-validator.js
function validateConfig() {
  const errors = [];

  if (!process.env.OPENAI_API_KEY) {
    errors.push('OPENAI_API_KEY is required');
  } else if (!process.env.OPENAI_API_KEY.startsWith('sk-')) {
    errors.push('OPENAI_API_KEY format invalid');
  }

  if (!process.env.FRONT_ORIGIN) {
    errors.push('FRONT_ORIGIN is required');
  }

  const port = parseInt(process.env.PORT || '4010', 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    errors.push(`Invalid PORT: ${process.env.PORT}`);
  }

  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }
}

validateConfig();
```

---

## 3. Deployment & Infrastructure

### 3.1 Deployment Documentation

#### ❌ P0-37: Zero Deployment Documentation
```markdown
# Current README:
## Quick start
cd backend
npm install
npm start

# Missing:
- How to deploy to production?
- What cloud platform? (Vercel? Railway? AWS?)
- Environment variable setup?
- Domain configuration?
- SSL certificate setup?
- Database? (None currently, but...)
```

**Required**: Add deployment guide
```markdown
# DEPLOYMENT.md

## Backend Deployment (Railway)

1. Create Railway project
2. Set environment variables:
   - OPENAI_API_KEY
   - OPENAI_MODEL
   - FRONT_ORIGIN
   - NODE_ENV=production
3. Deploy:
   railway up

## Frontend Deployment (Vercel)

1. Create Vercel project
2. Set environment variables:
   - NEXT_PUBLIC_API_BASE
3. Deploy:
   vercel --prod

## Post-Deployment Checklist
- [ ] Test /health endpoint
- [ ] Upload test PDF
- [ ] Complete one full interview
- [ ] Check logs for errors
- [ ] Verify OpenAI API calls in dashboard
```

### 3.2 Process Management

#### ⚠️ P1-32: No Process Manager
```javascript
// package.json:
"start": "node index.js"

// ❌ No PM2, no forever, no systemd
// ❌ Crashes don't auto-restart
// ❌ No log management
```

**Fix**:
```json
// package.json
{
  "scripts": {
    "start": "pm2 start ecosystem.config.js --env production",
    "stop": "pm2 stop homework-validator",
    "restart": "pm2 restart homework-validator",
    "logs": "pm2 logs homework-validator"
  }
}
```

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'homework-validator',
    script: './index.js',
    instances: 2, // Cluster mode
    exec_mode: 'cluster',
    env_production: {
      NODE_ENV: 'production',
      PORT: 4010,
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    max_memory_restart: '500M',
  }],
};
```

### 3.3 Health Checks & Monitoring

#### ⚠️ P1-6 (From Phase 1): Health Endpoint Exposes Internals
```javascript
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', model, hasApiKey });
  // ❌ Exposes model name and API key existence
});
```

**Fix**: Separate public/internal health endpoints
```javascript
// Public health (for load balancers)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Internal readiness (for k8s/monitoring)
app.get('/health/ready', async (_req, res) => {
  const checks = {
    openai: openai !== null,
    memory: process.memoryUsage().heapUsed < 400 * 1024 * 1024, // < 400MB
  };

  const allOk = Object.values(checks).every(Boolean);
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ready' : 'not_ready',
    checks,
  });
});

// Liveness (for k8s)
app.get('/health/live', (_req, res) => {
  res.json({ status: 'alive' });
});
```

---

## 4. Observability

### 4.1 Logging

#### ❌ P0-38: No Structured Logging
```javascript
// Current:
console.log('Backend listening on port', PORT);
console.error('pdf parse error', parseErr);
console.warn('analyze JSON parse failed', ...);

// Problems:
// - Can't parse logs programmatically
// - No log levels filtering
// - No request correlation
// - No log aggregation setup
```

**Fix**: Add structured logging
```javascript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Usage:
logger.info({ port: PORT }, 'Backend started');
logger.error({ err: parseErr, phase: 'pdf-parse' }, 'PDF parsing failed');
logger.warn({
  fallback,
  textLength: llmText?.length,
}, 'JSON parse failed');

// Request logging middleware:
app.use((req, res, next) => {
  req.log = logger.child({ reqId: crypto.randomUUID() });
  req.log.info({
    method: req.method,
    path: req.path,
  }, 'Request started');

  const startTime = Date.now();
  res.on('finish', () => {
    req.log.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - startTime,
    }, 'Request completed');
  });

  next();
});
```

### 4.2 Metrics & Monitoring

#### ❌ P0-39: No Monitoring/Alerting
```javascript
// Zero visibility into:
// - Request rate
// - Error rate
// - OpenAI API latency
// - OpenAI API cost
// - PDF parsing success rate
// - Session completion rate

// Production failures are silent
```

**Fix**: Add metrics
```javascript
import { register, Counter, Histogram } from 'prom-client';

// Metrics
const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
});

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'path'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

const openaiRequestsTotal = new Counter({
  name: 'openai_requests_total',
  help: 'Total OpenAI API requests',
  labelNames: ['endpoint', 'status'],
});

const pdfParseTotal = new Counter({
  name: 'pdf_parse_total',
  help: 'PDF parse attempts',
  labelNames: ['status'],
});

// Metrics endpoint
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Middleware to record metrics
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    httpRequestsTotal.inc({
      method: req.method,
      path: req.route?.path || req.path,
      status: res.statusCode,
    });
    httpRequestDuration.observe({
      method: req.method,
      path: req.route?.path || req.path,
    }, (Date.now() - start) / 1000);
  });
  next();
});
```

**Alerting Setup** (using Prometheus + Grafana):
```yaml
# prometheus-alerts.yml
groups:
  - name: homework-validator
    interval: 1m
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        annotations:
          summary: "High error rate detected"

      - alert: OpenAIFailures
        expr: rate(openai_requests_total{status="error"}[5m]) > 0.1
        for: 5m
        annotations:
          summary: "OpenAI API failing"

      - alert: PDFParseFailures
        expr: rate(pdf_parse_total{status="error"}[5m]) > 0.2
        for: 5m
        annotations:
          summary: "High PDF parse failure rate"
```

### 4.3 Error Tracking

#### ⚠️ P1-33: No Error Tracking Service
```javascript
// No Sentry, no Bugsnag, no Rollbar
// Errors logged to console, then lost
// No stack traces for frontend errors
```

**Fix**: Add Sentry
```javascript
// backend/index.js
import * as Sentry from '@sentry/node';

if (process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1, // 10% of transactions
  });

  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.errorHandler());
}

// frontend/app/layout.js
import * as Sentry from '@sentry/nextjs';

if (process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}
```

---

## 5. Disaster Recovery

### 5.1 Data Backup

#### ❌ P0-40: No Session State Persistence
```javascript
// All session data in memory
// Server restart → all active sessions lost
// No database, no Redis, no file storage

// User impact:
// - Mid-interview server crash
// - All progress lost
// - Must re-upload and restart
```

**Fix**: Add persistence layer
```javascript
// Option 1: Redis (recommended for scale)
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL);

// Store session
await redis.setex(
  `session:${sessionId}`,
  3600, // 1 hour TTL
  JSON.stringify({
    assignmentText,
    topics,
    currentTopicIndex,
    turns,
  })
);

// Retrieve session
const data = await redis.get(`session:${sessionId}`);
const session = JSON.parse(data);

// Option 2: SQLite (simple, single-server)
import Database from 'better-sqlite3';
const db = new Database('sessions.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);

// Store
const stmt = db.prepare(`
  INSERT OR REPLACE INTO sessions (id, data, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);
stmt.run(sessionId, JSON.stringify(sessionData), Date.now(), Date.now() + 3600000);
```

### 5.2 Recovery Procedures

#### ⚠️ P1-34: No Documented Recovery Plan
```markdown
# Missing:
- Server crash recovery steps
- Database restore procedure (when added)
- OpenAI API key rotation process
- Incident response playbook
```

**Required**: Create RUNBOOK.md
```markdown
# Operations Runbook

## Incident Response

### Server Crash
1. Check logs: `pm2 logs homework-validator`
2. Restart: `pm2 restart homework-validator`
3. Verify health: `curl https://api.example.com/health`
4. Check active sessions (if Redis): `redis-cli KEYS "session:*"`

### OpenAI API Down
1. Check status: https://status.openai.com
2. If extended outage, enable maintenance mode:
   - Set OPENAI_API_KEY="" (triggers fallback)
   - Update frontend to show maintenance banner
3. Monitor recovery, re-enable when resolved

### API Key Leaked
1. **IMMEDIATE**: Rotate key in OpenAI dashboard
2. Update OPENAI_API_KEY in all environments
3. Restart servers: `pm2 restart all`
4. Audit logs for unauthorized usage
5. Review git history to remove leaked key:
   git filter-branch --force --index-filter \
   "git rm --cached --ignore-unmatch backend/.env" \
   --prune-empty --tag-name-filter cat -- --all

### High Error Rate Alert
1. Check /metrics for specific errors
2. Review last 100 errors: `pm2 logs --err --lines 100`
3. Identify pattern (OpenAI? PDF parse? Frontend?)
4. Apply fix or rollback: `git revert HEAD && pm2 restart`

## Routine Maintenance

### Weekly
- Review error logs for patterns
- Check OpenAI API usage/costs
- Audit failed PDF uploads
- Review session completion rates

### Monthly
- Update dependencies: `npm audit && npm update`
- Rotate secrets (if policy requires)
- Review and archive old logs
- Test backup restore procedure
```

---

## 6. Performance & Scalability

### 6.1 Load Testing

#### ⚠️ P2-7: No Load Testing
```javascript
// Unknown capacity:
// - How many concurrent users?
// - What's the bottleneck?
// - When does it fall over?
```

**Recommendation**: Run load tests
```bash
# Using artillery
npm install -g artillery

# artillery.yml
config:
  target: "http://localhost:4010"
  phases:
    - duration: 60
      arrivalRate: 5  # 5 users/sec
      name: "Warm up"
    - duration: 300
      arrivalRate: 20  # 20 users/sec
      name: "Sustained load"
scenarios:
  - name: "Upload and analyze"
    flow:
      - post:
          url: "/api/analyze"
          json:
            pdfBase64: "{{pdfBase64Data}}"

# Run:
artillery run artillery.yml
```

### 6.2 Caching

#### ⚠️ P2-8: No Response Caching
```javascript
// Same PDF uploaded multiple times → same OpenAI call
// Could cache analysis results by PDF hash

// Potential savings:
// - Same assignment template used by many students
// - Could cache topic decomposition
```

**Future Enhancement**:
```javascript
import crypto from 'crypto';

app.post('/api/analyze', async (req, res) => {
  const { pdfBase64 } = req.body;

  // Hash PDF content
  const hash = crypto.createHash('sha256').update(pdfBase64).digest('hex');

  // Check cache
  const cached = await redis.get(`analysis:${hash}`);
  if (cached) {
    return res.json({ ...JSON.parse(cached), cached: true });
  }

  // Analyze
  const result = await analyzeAssignment(pdfBase64);

  // Cache for 24 hours
  await redis.setex(`analysis:${hash}`, 86400, JSON.stringify(result));

  res.json(result);
});
```

---

## 7. Compliance & Legal

### 7.1 Data Privacy

#### ⚠️ P1-35: No Privacy Policy
```markdown
# Required disclosures:
- What data is collected? (PDF content, conversation history)
- How long is it stored? (Session duration only? Forever?)
- Who has access? (OpenAI processes content)
- User rights? (GDPR: access, deletion, portability)
```

**Required**: Add privacy policy page
```markdown
# frontend/app/privacy/page.js

## Privacy Policy

### Data Collection
We collect:
- PDF documents you upload (temporary, session-only)
- Your answers during the interview (temporary, session-only)
- Usage analytics (anonymous)

### Data Processing
- Your PDF and answers are sent to OpenAI for AI analysis
- OpenAI's data policy: https://openai.com/policies/privacy-policy
- No data is stored permanently on our servers
- Sessions expire after 1 hour of inactivity

### Data Retention
- Session data deleted immediately after completion
- No persistent storage of your assignments or answers
- Logs retained for 30 days (IP addresses anonymized)

### Your Rights
- Access: Request your session data (while session active)
- Deletion: Clear browser to delete session
- Opt-out: Don't use the service

### Contact
privacy@example.com
```

### 7.2 Terms of Service

#### ⚠️ P2-9: No Terms of Service
```markdown
# Should include:
- Acceptable use policy (no malicious PDFs, no abuse)
- Liability disclaimer (AI-generated feedback is not official grading)
- Age restrictions (COPPA compliance if < 13)
- Service availability (no SLA guarantee)
```

---

## Summary: Phase 4 Findings

### P0 - Critical (Must Fix Before Production)
1. ❌ **No HTTPS enforcement** - Credentials in plaintext
2. ❌ **Missing security headers** - No CSP, HSTS, etc.
3. ❌ **No environment separation** - Dev/prod config mixed
4. ❌ **Secrets in .env** - Verify not in git, rotate if leaked
5. ❌ **No session persistence** - Server crash = data loss
6. ❌ **No monitoring** - Silent production failures
7. ❌ **No deployment docs** - Can't deploy to production

### P1 - Important (Should Fix Soon)
1. ⚠️ No authentication system (acceptable for MVP)
2. ⚠️ No CSRF protection (low risk, stateless)
3. ⚠️ No config validation on startup
4. ⚠️ No process manager (PM2)
5. ⚠️ Health endpoint leaks internals
6. ⚠️ No error tracking (Sentry)
7. ⚠️ No recovery playbook
8. ⚠️ No privacy policy
9. ⚠️ No structured logging
10. ⚠️ Frontend vulnerabilities (eslint packages)

### P2 - Recommended (Nice to Have)
1. ○ No load testing performed
2. ○ No response caching
3. ○ No terms of service
4. ○ No rate limit per user (only per IP)
5. ○ No CDN for static assets
6. ○ No database (in-memory only)

---

## Production Launch Checklist

### Pre-Launch (P0 Must-Haves)
- [ ] **Security**
  - [ ] Enable HTTPS (Let's Encrypt or cloud platform)
  - [ ] Add helmet.js for security headers
  - [ ] Fix frontend npm vulnerabilities
  - [ ] Verify .env not in git history
  - [ ] Rotate secrets if any were exposed
  - [ ] Add structured logging (Pino)

- [ ] **Infrastructure**
  - [ ] Create .env.production with prod secrets
  - [ ] Document deployment process (DEPLOYMENT.md)
  - [ ] Set up session persistence (Redis or SQLite)
  - [ ] Configure monitoring (Prometheus + Grafana or cloud monitoring)
  - [ ] Set up alerting (PagerDuty or email)

- [ ] **Testing**
  - [ ] Test full user flow in production-like environment
  - [ ] Test error scenarios (OpenAI down, PDF fail, timeout)
  - [ ] Test session recovery after restart

### Post-Launch (P1 Should-Haves)
- [ ] **Operations**
  - [ ] Set up process manager (PM2)
  - [ ] Create operations runbook
  - [ ] Set up error tracking (Sentry)
  - [ ] Configure log aggregation
  - [ ] Schedule first incident response drill

- [ ] **Compliance**
  - [ ] Add privacy policy page
  - [ ] Add terms of service
  - [ ] Review OpenAI data processing agreement
  - [ ] Set up GDPR data deletion workflow

### Future (P2 Nice-to-Haves)
- [ ] Run load tests, establish capacity baseline
- [ ] Implement response caching
- [ ] Add CDN for frontend assets
- [ ] Consider database for analytics
- [ ] Set up A/B testing framework

---

**Phase 4 Complete** - Ready for final consolidation
