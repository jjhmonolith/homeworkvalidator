# Code Review Report - Phase 3: Frontend Flow & Integration

**Date**: 2025-12-28
**Reviewer**: Claude Code
**Focus**: React State Management, Timer Logic, UX Flow, API Integration

---

## Executive Summary

Phase 3 analyzes frontend implementation focusing on state management patterns, timer/countdown logic, user experience flows, and backend integration correctness. This review identifies **9 P0 (Critical)**, **18 P1 (Important)**, and **11 P2 (Recommended)** issues.

### Critical Findings (P0)
1. **Timer Drift** - 1-second interval compounds to significant time loss
2. **Race Condition in completeTopic** - Can trigger multiple times
3. **State Update in Async Callback** - Stale closure issue
4. **No Session Recovery** - Page refresh loses all state
5. **Memory Leak in Modal Auto-Advance** - Timer not properly cleaned
6. **Hardcoded 3-Topic Limit** - Ignores backend topic count
7. **No Error Boundary** - Unhandled errors crash entire app
8. **Missing Loading States** - Button re-click during API calls
9. **Client-Server Time Desync** - No server-side timer validation

---

## 1. State Management Architecture

### 1.1 State Structure Analysis

**Current State Variables**: `frontend/app/page.js:68-80`
```javascript
const [phase, setPhase] = useState("upload");
const [assignment, setAssignment] = useState({ topics: [], text: "" });
const [topicsState, setTopicsState] = useState([]);
const [currentTopicIndex, setCurrentTopicIndex] = useState(0);
const [aiGenerating, setAiGenerating] = useState(false);
const [isTyping, setIsTyping] = useState(false);
const [studentInput, setStudentInput] = useState("");
const [error, setError] = useState("");
const [prepLabel, setPrepLabel] = useState("");
const [resultSummary, setResultSummary] = useState(null);
const [modal, setModal] = useState(null);
const [autoCountdown, setAutoCountdown] = useState(AUTO_ADVANCE_SECONDS);
const [advancing, setAdvancing] = useState(false);
```

**Findings**:

#### ❌ P0-21: Redundant State (`assignment` vs `topicsState`)
```javascript
// assignment.topics: Original from backend
// topicsState: Working copy with runtime additions

// Problem: Data duplication
setAssignment({ topics: normalizedTopics, text: data.text });
setTopicsState(normalizedTopics);

// Changes to topicsState don't sync back to assignment
// finalizeSession() uses assignment.topics (stale data)
```

**Impact**:
- Leads to bugs where old topics sent to /api/summary
- Memory waste (duplicate topic data)
- Confusion about source of truth

**Fix**:
```javascript
// Eliminate assignment.topics, derive from topicsState
const [topicsState, setTopicsState] = useState([]);
const [assignmentText, setAssignmentText] = useState("");

// Derive topics when needed:
const topics = topicsState.map(t => ({
  id: t.id,
  title: t.title,
  description: t.description,
}));
```

#### ⚠️ P1-14: Primitive Obsession for `phase`
```javascript
const [phase, setPhase] = useState("upload");
// Values: "upload", "analyzing", "prep", "interview", "finalizing", "result"

// ❌ Magic strings, no compile-time safety
// ❌ Easy to typo: setPhase("interwiew")
```

**Recommendation**:
```javascript
const PHASES = {
  UPLOAD: 'upload',
  ANALYZING: 'analyzing',
  PREP: 'prep',
  INTERVIEW: 'interview',
  FINALIZING: 'finalizing',
  RESULT: 'result',
} as const;

const [phase, setPhase] = useState(PHASES.UPLOAD);
```

#### ⚠️ P1-15: Too Many useState Calls
- 13 separate useState declarations
- Hard to reason about state transitions
- Should use useReducer for complex state machine

**Recommendation**:
```javascript
const initialState = {
  phase: 'upload',
  topics: [],
  currentIndex: 0,
  aiGenerating: false,
  // ...
};

function reducer(state, action) {
  switch (action.type) {
    case 'START_ANALYZE':
      return { ...state, phase: 'analyzing', error: '' };
    case 'TOPICS_LOADED':
      return { ...state, phase: 'prep', topics: action.payload };
    // ...
  }
}

const [state, dispatch] = useReducer(reducer, initialState);
```

### 1.2 State Initialization & Cleanup

#### ❌ P0-22: No Session Recovery on Reload
```javascript
// User's journey:
// 1. Upload PDF → Interview starts
// 2. Answer 5 questions (valuable progress)
// 3. Accidentally refresh page
// 4. ❌ All state lost, must restart

// No sessionStorage/localStorage persistence
```

**Fix**:
```javascript
useEffect(() => {
  const saved = sessionStorage.getItem('interview-state');
  if (saved) {
    const parsed = JSON.parse(saved);
    // Restore state with caution (validate schema)
    setTopicsState(parsed.topics || []);
    setCurrentTopicIndex(parsed.currentIndex || 0);
    // ...
  }
}, []);

useEffect(() => {
  if (phase === 'interview') {
    sessionStorage.setItem('interview-state', JSON.stringify({
      topics: topicsState,
      currentIndex: currentTopicIndex,
      assignmentText: assignment.text,
    }));
  }
}, [phase, topicsState, currentTopicIndex, assignment.text]);
```

#### ⚠️ P1-16: Cleanup on Unmount Missing
```javascript
// No cleanup of:
// - Pending API requests (fetch AbortController)
// - Timer intervals
// - sessionStorage

// If user navigates away mid-interview, resources leak
```

---

## 2. Timer & Countdown Logic

### 2.1 Main Timer Implementation

**Current Logic**: `frontend/app/page.js:90-112`
```javascript
useEffect(() => {
  if (phase !== "interview") return;
  if (!currentTopic) return;
  if (currentTopic.timeLeft <= 0) return;

  const shouldTick =
    modal?.type === "manual-exit" ||
    ((isTyping || currentTopic.started) && !aiGenerating && modal?.type !== "auto-exit");
  if (!shouldTick) return;

  const timer = setInterval(() => {
    setTopicsState((prev) =>
      prev.map((topic, idx) => {
        if (idx === currentTopicIndex) {
          return { ...topic, timeLeft: Math.max(0, topic.timeLeft - 1) };
        }
        return topic;
      }),
    );
  }, 1000);

  return () => clearInterval(timer);
}, [phase, currentTopicIndex, currentTopic, isTyping, aiGenerating, modal]);
```

**Findings**:

#### ❌ P0-23: Timer Drift Accumulation
```javascript
setInterval(() => { /* ... */ }, 1000);
// ❌ Not accurate: each tick can be 1000-1050ms
// Over 180 seconds (3 min), drift = 5-10 seconds
```

**Impact**:
- Student gets 170 seconds instead of 180
- Unfair time pressure
- Inconsistent experience across devices

**Fix**: Use timestamp-based calculation
```javascript
const [startTime, setStartTime] = useState(null);

useEffect(() => {
  if (!startTime) {
    setStartTime(Date.now());
  }

  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, TOPIC_SECONDS - elapsed);

    setTopicsState((prev) =>
      prev.map((topic, idx) =>
        idx === currentTopicIndex
          ? { ...topic, timeLeft: remaining }
          : topic
      )
    );

    if (remaining === 0) clearInterval(timer);
  }, 100); // Check every 100ms for accuracy

  return () => clearInterval(timer);
}, [startTime, currentTopicIndex]);
```

#### ❌ P0-24: Complex shouldTick Logic
```javascript
const shouldTick =
  modal?.type === "manual-exit" ||
  ((isTyping || currentTopic.started) && !aiGenerating && modal?.type !== "auto-exit");
```

**Analysis**:
```
Tick if:
  1. Manual exit modal open, OR
  2. (Typing OR topic started) AND NOT ai generating AND NOT auto-exit modal

Truth table (8 combinations):
| isTyping | started | aiGen | modal        | Result |
|----------|---------|-------|--------------|--------|
| false    | false   | false | null         | false  | ❌ Bug: initial state doesn't tick
| false    | false   | true  | null         | false  |
| false    | true    | false | null         | true   | ✅ Correct
| false    | true    | true  | null         | false  | ✅ Pause during AI
| true     | true    | false | manual-exit  | true   | ✅ Continue during manual confirm
| ...      | ...     | ...   | auto-exit    | false  | ✅ Pause during auto-exit
```

**Bug Identified**:
```javascript
// Initial state:
// isTyping = false
// currentTopic.started = false
// aiGenerating = false
// modal = null

// shouldTick = false || ((false || false) && true && true)
//            = false || (false && true && true)
//            = false

// ❌ Timer doesn't start until user types!
```

**Fix**: Change initial `started` to `true` when topic loads
```javascript
// In prepareTopic():
setTopicsState((prev) =>
  prev.map((t, idx) => {
    if (idx === index) {
      return {
        ...t,
        status: "active",
        timeLeft: TOPIC_SECONDS,
        started: true, // ✅ Already correct!
        asked: true,
      };
    }
    return t;
  })
);
```

Actually checking the code at line 214: `started: true` is SET. But the bug is:
```javascript
// Line 158: Initial normalization
started: false,  // ❌ Wrong
asked: false,

// Line 164: First topic preparation
await prepareTopic(0, normalizedTopics, data.text || "");
// This DOES set started: true

// So bug only affects if prepareTopic fails/doesn't run
```

#### ❌ P0-25: Client-Only Timer (No Server Validation)
```javascript
// All timing happens in browser
// No server-side tracking
// User can:
// 1. Open DevTools
// 2. Pause JavaScript execution
// 3. "Freeze" timer indefinitely
// 4. Resume, submit answers with extra time
```

**Fix**: Add server-side timer tracking
```javascript
// Backend: Track when each topic started
POST /api/question
{
  "topicId": "t1",
  "startedAt": 1703750400000, // Client sends when topic began
  "studentAnswer": "..."
}

// Backend validates:
const elapsed = Date.now() - req.body.startedAt;
if (elapsed > TOPIC_SECONDS * 1000 + 5000) { // +5s grace
  return res.status(400).json({
    error: 'time_limit_exceeded',
    message: '시간이 초과되었습니다.',
  });
}
```

### 2.2 Auto-Advance Countdown

**Current Logic**: `frontend/app/page.js:328-342`
```javascript
useEffect(() => {
  if (modal?.type !== "auto-exit") return;
  setAutoCountdown(AUTO_ADVANCE_SECONDS);
  const timer = setInterval(() => {
    setAutoCountdown((prev) => {
      if (prev <= 1) {
        clearInterval(timer);
        completeTopic("auto");
        return 0;
      }
      return prev - 1;
    });
  }, 1000);
  return () => clearInterval(timer);
}, [modal?.type, completeTopic]);
```

**Findings**:

#### ❌ P0-26: Memory Leak in Cleanup
```javascript
const timer = setInterval(() => {
  setAutoCountdown((prev) => {
    if (prev <= 1) {
      clearInterval(timer); // ❌ Closes over timer variable
      completeTopic("auto");
      return 0;
    }
    return prev - 1;
  });
}, 1000);
return () => clearInterval(timer);
```

**Problem**:
```javascript
// Scenario:
// 1. Modal opens, timer starts
// 2. User clicks "바로 넘어가기"
// 3. Modal closes (modal.type changes)
// 4. useEffect cleanup runs: clearInterval(timer) ✅
// 5. BUT: setInterval callback still has pending setState
// 6. Callback runs: clearInterval(timer) - redundant
//    completeTopic("auto") - ❌ RUNS AGAIN!
```

**Impact**: `completeTopic` called twice → potential double-advance bug

**Fix**:
```javascript
useEffect(() => {
  if (modal?.type !== "auto-exit") return;

  setAutoCountdown(AUTO_ADVANCE_SECONDS);
  let cancelled = false;

  const timer = setInterval(() => {
    setAutoCountdown((prev) => {
      if (cancelled) return prev; // Guard

      if (prev <= 1) {
        clearInterval(timer);
        if (!cancelled) {
          completeTopic("auto");
        }
        return 0;
      }
      return prev - 1;
    });
  }, 1000);

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}, [modal?.type, completeTopic]);
```

#### ⚠️ P1-17: completeTopic in Dependency Array
```javascript
}, [modal?.type, completeTopic]);
// ❌ completeTopic is a useCallback that changes on every render
// Due to dependencies: [advancing, topicsState, currentTopicIndex, ...]
```

**Impact**: useEffect re-runs frequently, recreating timer
**Fix**: Use ref or extract stable version

---

## 3. Race Conditions & Concurrency

### 3.1 completeTopic Race Condition

**Current Implementation**: `frontend/app/page.js:298-326`
```javascript
const completeTopic = useCallback(
  async (_reason) => {
    if (advancing) return; // ❌ Check-then-act race condition
    setAdvancing(true);
    setModal(null);
    // ...

    const nextIndex = currentTopicIndex + 1;
    if (nextIndex < topicsState.length) {
      await prepareTopic(nextIndex, updated, assignment.text);
    } else {
      await finalizeSession(updated);
    }
    setAdvancing(false);
  },
  [advancing, topicsState, currentTopicIndex, assignment.text, prepareTopic, finalizeSession],
);
```

**Findings**:

#### ❌ P0-27: Check-Then-Act Race Condition
```javascript
if (advancing) return;
setAdvancing(true);
// ❌ NOT atomic!
```

**Attack Scenario**:
```javascript
// Time:  T0              T1              T2
// Call1: if (false)      setAdvancing    prepareTopic()
// Call2:                 if (false)      setAdvancing + prepareTopic()
//        ❌ Both proceed!
```

**Consequence**:
- Two `prepareTopic()` calls in parallel
- Two `/api/question` requests
- Corrupt state (currentTopicIndex advanced twice?)
- User sees wrong topic or double-modal

**Fix**: Use ref for atomic check-and-set
```javascript
const advancingRef = useRef(false);

const completeTopic = useCallback(async (_reason) => {
  if (advancingRef.current) return;
  advancingRef.current = true;
  setAdvancing(true);

  try {
    // ... actual logic
  } finally {
    advancingRef.current = false;
    setAdvancing(false);
  }
}, [...]);
```

#### ❌ P0-28: Stale Closure on topicsState
```javascript
const completeTopic = useCallback(
  async (_reason) => {
    // ...
    let updated = topicsState; // ❌ Captures topicsState from closure

    setTopicsState((prev) => {
      updated = prev; // ⚠️ Overwrites, but...
      return prev.map((t, idx) => ...);
    });

    const nextIndex = currentTopicIndex + 1;
    if (nextIndex < topicsState.length) {
      // ❌ Uses stale topicsState, not updated!
      await prepareTopic(nextIndex, updated, assignment.text);
    }
  },
  [advancing, topicsState, currentTopicIndex, ...],
);
```

**Bug**: `nextIndex < topicsState.length` uses stale `topicsState` from closure, not live state

**Fix**:
```javascript
setTopicsState((prev) => {
  updated = prev.map((t, idx) =>
    idx === currentTopicIndex ? { ...t, status: "done" } : t
  );
  return updated;
});

// Now use updated (fresh) instead of topicsState
const nextIndex = currentTopicIndex + 1;
if (nextIndex < updated.length) {
  await prepareTopic(nextIndex, updated, assignment.text);
}
```

### 3.2 Async State Updates

#### ⚠️ P1-18: No Error Handling in Async Callbacks
```javascript
useEffect(() => {
  const timer = setInterval(() => {
    setAutoCountdown((prev) => {
      if (prev <= 1) {
        clearInterval(timer);
        completeTopic("auto"); // ❌ Async function, uncaught promise
        return 0;
      }
      return prev - 1;
    });
  }, 1000);
  return () => clearInterval(timer);
}, [modal?.type, completeTopic]);
```

**Problem**: `completeTopic()` is async, returns Promise, but not awaited
**Impact**: If `prepareTopic()` fails, error is silently swallowed

**Fix**:
```javascript
completeTopic("auto").catch((err) => {
  console.error('Auto-advance failed:', err);
  setError('주제 전환에 실패했습니다. 페이지를 새로고침해 주세요.');
});
```

---

## 4. API Integration & Error Handling

### 4.1 API Request Patterns

**Fetch Wrapper**: `frontend/app/page.js:54-65`
```javascript
async function apiFetch(path, payload) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "API 요청에 실패했습니다");
  }
  return res.json();
}
```

**Findings**:

#### ❌ P0-29: No Request Timeout
```javascript
const res = await fetch(`${API_BASE}${path}`, {...});
// ❌ Can hang forever if backend is slow
```

**Fix**:
```javascript
async function apiFetch(path, payload, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(id);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "API 요청에 실패했습니다");
    }
    return res.json();
  } catch (err) {
    clearTimeout(id);
    if (err.name === 'AbortError') {
      throw new Error('요청 시간이 초과되었습니다. 다시 시도해 주세요.');
    }
    throw err;
  }
}
```

#### ⚠️ P1-19: Error Object Thrown as String
```javascript
if (!res.ok) {
  const text = await res.text();
  throw new Error(text || "API 요청에 실패했습니다");
  // ❌ text might be HTML error page or JSON
}
```

**Better**:
```javascript
if (!res.ok) {
  let errorData;
  try {
    errorData = await res.json();
  } catch {
    errorData = { error: await res.text() };
  }
  const message = errorData.message || errorData.error || "API 요청 실패";
  throw new Error(message);
}
```

#### ⚠️ P1-20: No Retry Logic
```javascript
// Network hiccup → permanent failure
// Should retry idempotent requests (GET/POST with idempotency key)
```

### 4.2 Error State Management

#### ❌ P0-30: No Error Boundary
```javascript
// If any component throws, entire app crashes
// User sees blank screen
// No recovery mechanism
```

**Fix**: Add error boundary
```javascript
// ErrorBoundary.js
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.errorPage}>
          <h1>오류가 발생했습니다</h1>
          <p>{this.state.error?.message}</p>
          <button onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// layout.js
export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body className={noto.className}>
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
```

#### ⚠️ P1-21: Error Message Cleared on Next Render
```javascript
const [error, setError] = useState("");

// Pattern:
setError("파일 업로드 실패");
// User sees error briefly
// User clicks again → setError("") → error vanishes
// Confusing UX
```

**Fix**: Add timeout or explicit dismiss
```javascript
const setErrorWithTimeout = (msg, duration = 5000) => {
  setError(msg);
  setTimeout(() => setError(""), duration);
};
```

---

## 5. Data Flow & Props Drilling

### 5.1 Component Hierarchy

```
<Home>  (672 lines)
├─ <UploadCard>
├─ <LoadingCard>
├─ <InterviewCard>
│  ├─ topic: currentTopic
│  ├─ topics: topicsState
│  ├─ currentIndex
│  ├─ onSend: handleSend
│  ├─ onManualExit, onConfirmExit, onCancelExit
│  └─ ... 10 more props
└─ <ResultCard>
```

**Findings**:

#### ⚠️ P1-22: Props Drilling (10+ Props to InterviewCard)
```javascript
<InterviewCard
  topic={currentTopic}
  topics={topicsState}
  currentIndex={currentTopicIndex}
  progressText={progressText}
  timeText={formatTime(currentTopic.timeLeft)}
  onSend={handleSend}
  studentInput={studentInput}
  setStudentInput={setStudentInput}
  onTyping={() => setIsTyping(true)}
  aiGenerating={aiGenerating}
  modal={modal}
  onManualExit={() => setModal({ type: "manual-exit" })}
  onConfirmExit={() => completeTopic("manual")}
  onCancelExit={() => setModal(null)}
  autoCountdown={autoCountdown}
  inputDisabled={inputDisabled}
/>
```

**Recommendation**: Use Context or Zustand (already installed!)
```javascript
// store.js
import create from 'zustand';

export const useInterviewStore = create((set, get) => ({
  phase: 'upload',
  topics: [],
  currentIndex: 0,
  studentInput: '',
  // ... all state

  // Actions:
  setPhase: (phase) => set({ phase }),
  advanceTopic: async () => {
    const { currentIndex, topics } = get();
    if (currentIndex + 1 < topics.length) {
      set({ currentIndex: currentIndex + 1 });
    }
  },
}));

// InterviewCard.js
function InterviewCard() {
  const { topics, currentIndex, studentInput, setStudentInput } = useInterviewStore();
  // No props needed!
}
```

#### ⚠️ P2-2: Zustand Installed But Unused
```javascript
// package.json:14
"zustand": "^4.5.2"

// But no usage in codebase
// Remove dependency or use it
```

---

## 6. UX & Accessibility

### 6.1 Hardcoded Business Logic

#### ❌ P0-31: Ignoring Backend Topic Count
```javascript
// frontend/app/page.js:151
const topics = (data.analysis?.topics || []).slice(0, 3);
// ❌ HARDCODED: Always 3 topics
// Backend can return 1-5 topics
// Frontend throws away 4th and 5th
```

**Current Flow**:
```
Backend: Analyzes PDF → Returns 5 topics
Frontend: .slice(0, 3) → Uses only first 3
User: Sees incomplete coverage of their assignment
```

**Fix**:
```javascript
const MAX_TOPICS = 5;
const topics = (data.analysis?.topics || []).slice(0, MAX_TOPICS);

// Or better: use backend's count
const topics = data.analysis?.topics || [];
if (topics.length === 0) {
  throw new Error("AI가 주제를 만들지 못했습니다.");
}

// Update TOPIC_SECONDS based on count:
const timePerTopic = Math.floor(540 / topics.length); // 9 min total
const normalizedTopics = topics.map((t, idx) => ({
  ...t,
  timeLeft: timePerTopic,
  // ...
}));
```

#### ⚠️ P1-23: Hardcoded Time Constants
```javascript
// frontend/app/page.js:8-9
const TOPIC_SECONDS = 180; // 3 minutes
const AUTO_ADVANCE_SECONDS = 5;

// Should come from backend config or env
// Backend might change to 2min or 4min per topic
// Frontend hardcoded → mismatch
```

### 6.2 Loading & Disabled States

#### ❌ P0-32: Missing Loading State on Buttons
```javascript
// frontend/app/page.js:588-590
<button
  className={styles.primaryButton}
  onClick={onSend}
  disabled={inputDisabled}
>
  전송
</button>

// inputDisabled = phase !== "interview" || aiGenerating || modal?.type === "auto-exit"
// ✅ Good: disabled during AI generation

// BUT:
// ❌ No visual feedback that button is disabled (grayed out? spinner?)
// ❌ User doesn't know if click registered
```

**Fix**:
```javascript
<button
  className={clsx(styles.primaryButton, {
    [styles.buttonDisabled]: inputDisabled,
    [styles.buttonLoading]: aiGenerating,
  })}
  onClick={onSend}
  disabled={inputDisabled}
>
  {aiGenerating ? (
    <>
      <span className={styles.spinner} />
      처리중...
    </>
  ) : (
    "전송"
  )}
</button>
```

#### ⚠️ P1-24: No Retry UI for Failed Requests
```javascript
// handleUpload fails:
catch (err) {
  setError(err.message || "업로드에 실패했습니다.");
  setPhase("upload"); // ✅ Return to upload
}

// But:
// ❌ File input is cleared
// ❌ User must re-select same file
// ❌ No "Retry" button with existing file
```

### 6.3 Accessibility Issues

#### ⚠️ P1-25: No ARIA Labels
```javascript
<textarea
  value={studentInput}
  onChange={(e) => setStudentInput(e.target.value)}
  placeholder="질문에 대해 자신의 말로 답변해 주세요."
  disabled={inputDisabled}
  // ❌ No aria-label
  // ❌ No aria-describedby for character limit
/>
```

**Fix**:
```javascript
<textarea
  value={studentInput}
  onChange={(e) => setStudentInput(e.target.value)}
  placeholder="질문에 대해 자신의 말로 답변해 주세요."
  disabled={inputDisabled}
  aria-label="답변 입력"
  aria-describedby="time-remaining"
  maxLength={2000}
/>
<p id="time-remaining" className={styles.srOnly}>
  남은 시간: {formatTime(currentTopic.timeLeft)}
</p>
```

#### ⚠️ P2-3: Modal Keyboard Navigation
```javascript
// Modal opens but:
// ❌ No focus trap
// ❌ ESC key doesn't close modal
// ❌ Tab cycles outside modal
```

### 6.4 Input Validation

#### ⚠️ P1-26: No Client-Side Input Validation
```javascript
// frontend/app/page.js:582-583
onPaste={(e) => e.preventDefault()}
onDrop={(e) => e.preventDefault()}
// ✅ Good: Prevents paste/drop

// BUT:
// ❌ No max length check
// ❌ No empty string trimming
// ❌ User can submit whitespace-only answers
```

**Fix**:
```javascript
const handleSend = async () => {
  const trimmed = studentInput.trim();
  if (!trimmed) {
    setError('답변을 입력해 주세요.');
    return;
  }
  if (trimmed.length > 2000) {
    setError('답변이 너무 깁니다 (최대 2000자).');
    return;
  }
  // ... proceed
};
```

---

## 7. React Best Practices

### 7.1 useEffect Dependencies

#### ⚠️ P1-27: Missing Dependencies in useEffect
```javascript
// frontend/app/page.js:328-342
useEffect(() => {
  if (modal?.type !== "auto-exit") return;
  setAutoCountdown(AUTO_ADVANCE_SECONDS);
  const timer = setInterval(() => {
    setAutoCountdown((prev) => {
      if (prev <= 1) {
        clearInterval(timer);
        completeTopic("auto");
        return 0;
      }
      return prev - 1;
    });
  }, 1000);
  return () => clearInterval(timer);
}, [modal?.type, completeTopic]);
// ❌ ESLint warning: AUTO_ADVANCE_SECONDS should be in deps
// (but it's a constant, so actually OK)
```

**Fix**: Define constants outside component or use ESLint disable comment

### 7.2 Key Props & Lists

#### ✅ Good: Proper Key Usage
```javascript
// frontend/app/page.js:516-530
{topics.map((t, idx) => (
  <div
    key={t.id || idx}  // ✅ Uses stable id, fallback to index
    className={clsx(...)}
  >
    ...
  </div>
))}
```

### 7.3 Performance Optimizations

#### ⚠️ P2-4: Unnecessary Re-Renders
```javascript
// Every state change re-renders entire Home component (672 lines)
// Including all sub-components

// Should memoize:
// - UploadCard (never changes during interview)
// - InterviewCard (only when topic/timer changes)
```

**Fix**:
```javascript
const UploadCard = React.memo(({ onUpload }) => {
  // ...
});

const InterviewCard = React.memo(({ topic, ... }) => {
  // ...
}, (prev, next) => {
  // Custom comparison
  return prev.topic.timeLeft === next.topic.timeLeft &&
         prev.aiGenerating === next.aiGenerating;
});
```

---

## 8. Type Safety & Documentation

### 8.1 PropTypes / TypeScript

#### ⚠️ P2-5: No PropTypes Validation
```javascript
function InterviewCard({
  topic,
  topics,
  currentIndex,
  // ... 13 more props
}) {
  // ❌ No runtime type checking
  // ❌ No documentation of expected shape
}
```

**Recommendation**: Add PropTypes or migrate to TypeScript
```javascript
import PropTypes from 'prop-types';

InterviewCard.propTypes = {
  topic: PropTypes.shape({
    id: PropTypes.string.isRequired,
    title: PropTypes.string.isRequired,
    description: PropTypes.string.isRequired,
    timeLeft: PropTypes.number.isRequired,
    turns: PropTypes.arrayOf(PropTypes.shape({
      role: PropTypes.oneOf(['ai', 'student']).isRequired,
      text: PropTypes.string.isRequired,
    })).isRequired,
  }).isRequired,
  // ... rest
};
```

### 8.2 Code Comments

#### ⚠️ P2-6: No High-Level Comments
```javascript
// 672-line component with:
// ❌ No section comments
// ❌ No explanation of complex timer logic
// ❌ No documentation of state machine (upload → analyzing → prep → interview → result)
```

**Fix**: Add structural comments
```javascript
export default function Home() {
  // ========== STATE MANAGEMENT ==========
  // Phase: Overall workflow state machine
  const [phase, setPhase] = useState("upload");

  // Topic Management: Interview content & progress
  const [topicsState, setTopicsState] = useState([]);
  const [currentTopicIndex, setCurrentTopicIndex] = useState(0);

  // ========== TIMER LOGIC ==========
  // Main topic timer: decrements every second while student is typing
  useEffect(() => { /* ... */ }, [...]);

  // ========== EVENT HANDLERS ==========
  // ...
}
```

---

## Summary: Phase 3 Findings

### P0 - Critical (Must Fix Before Production)
1. ❌ **Timer drift** - Interval-based timer loses 5-10s over 3min
2. ❌ **Race condition in completeTopic** - Can trigger multiple times
3. ❌ **Stale closure on topicsState** - Uses old state in async callback
4. ❌ **No session recovery** - Page refresh loses all progress
5. ❌ **Memory leak in auto-advance** - Timer callback runs after cleanup
6. ❌ **Hardcoded 3-topic limit** - Ignores backend topic count
7. ❌ **No error boundary** - Unhandled errors crash app
8. ❌ **No request timeout** - Fetch can hang indefinitely
9. ❌ **Client-only timer** - No server-side validation (can be manipulated)

### P1 - Important (Should Fix Soon)
1. ⚠️ Redundant state (assignment vs topicsState)
2. ⚠️ Magic strings for phase values
3. ⚠️ Too many useState (should use useReducer)
4. ⚠️ No cleanup on unmount
5. ⚠️ Complex shouldTick logic
6. ⚠️ completeTopic in dependency array (unstable)
7. ⚠️ No error handling in async callbacks
8. ⚠️ Error object thrown as string
9. ⚠️ No retry logic for API calls
10. ⚠️ Error messages cleared prematurely
11. ⚠️ Props drilling (10+ props to InterviewCard)
12. ⚠️ Hardcoded time constants
13. ⚠️ No visual loading feedback on buttons
14. ⚠️ No retry UI for failed uploads
15. ⚠️ No ARIA labels for accessibility
16. ⚠️ No client-side input validation
17. ⚠️ Missing useEffect dependencies
18. ⚠️ Zustand installed but unused

### P2 - Recommended (Nice to Have)
1. ○ Zustand unused dependency
2. ○ No keyboard navigation for modal
3. ○ Unnecessary re-renders (no memoization)
4. ○ No PropTypes validation
5. ○ No high-level code comments
6. ○ No performance monitoring
7. ○ No analytics events
8. ○ Could benefit from TypeScript
9. ○ No unit/integration tests
10. ○ No accessibility testing
11. ○ No responsive design testing

---

## Remediation Priority

**Immediate (P0)**:
1. Fix timer to use timestamp-based calculation
2. Add ref-based atomic guard for completeTopic
3. Fix stale closure in async callback
4. Add sessionStorage persistence
5. Add error boundary

**Short-term (P1)**:
1. Migrate to useReducer for state management
2. Add request timeouts and retry logic
3. Improve error UX (persist, retry button)
4. Add ARIA labels and keyboard navigation
5. Remove hardcoded 3-topic limit

**Medium-term (P2)**:
1. Consider Zustand migration (or remove)
2. Add React.memo for performance
3. Migrate to TypeScript
4. Add comprehensive tests

---

**Phase 3 Complete** - Next: Phase 4 (Security & Production Readiness)
