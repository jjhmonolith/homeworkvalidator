"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import styles from "./page.module.css";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4010";
const TOPIC_SECONDS = 180;
const AUTO_ADVANCE_SECONDS = 5;

const phaseLabels = {
  upload: "과제 업로드",
  analyzing: "과제 분석중",
  prep: "인터뷰 준비중",
  interview: "인터뷰 진행중",
  finalizing: "결과 분석중",
  result: "결과",
};

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const m = String(Math.floor(safe / 60)).padStart(2, "0");
  const s = String(safe % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function buildTranscript(topics = []) {
  return topics
    .map((topic) =>
      (topic.turns || [])
        .map((turn) => `${turn.role === "ai" ? "AI" : "학생"}: ${turn.text}`)
        .join("\n"),
    )
    .join("\n");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        const base64 = result.split(",")[1];
        resolve(base64);
      } else {
        reject(new Error("파일을 읽을 수 없습니다."));
      }
    };
    reader.onerror = () => reject(new Error("파일을 읽는 중 오류가 발생했습니다."));
    reader.readAsDataURL(file);
  });
}

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

export default function Home() {
  const [phase, setPhase] = useState("upload");
  const [assignment, setAssignment] = useState({ summary: "", topics: [], text: "" });
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

  const currentTopic = topicsState[currentTopicIndex];

  useEffect(() => {
    if (!isTyping) return;
    const timer = setTimeout(() => setIsTyping(false), 5000);
    return () => clearTimeout(timer);
  }, [isTyping]);

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

  useEffect(() => {
    if (phase !== "interview") return;
    if (!currentTopic) return;
    if (currentTopic.timeLeft > 0) return;
    if (modal?.type === "auto-exit" || advancing) return;
    triggerAutoModal();
  }, [phase, currentTopic, modal, advancing]);

  const progressText = topicsState.length ? `${currentTopicIndex + 1}/${topicsState.length}` : "";

  const inputDisabled = phase !== "interview" || aiGenerating || modal?.type === "auto-exit";

  const fetchQuestion = async ({ topic, previousQA, studentAnswer }) => {
    const data = await apiFetch("/api/question", {
      summary: assignment.summary,
      topic,
      excerpt: (assignment.text || "").slice(0, 1500),
      previousQA,
      studentAnswer,
    });
    return data.question || "주제와 관련된 내용을 더 자세히 설명해 주시겠어요?";
  };

  const handleUpload = async (file) => {
    if (!file) {
      setError("PDF 파일을 선택해 주세요.");
      return;
    }
    if (file.type !== "application/pdf") {
      setError("PDF 파일만 업로드할 수 있습니다.");
      return;
    }
    setError("");
    setPhase("analyzing");
    try {
      const base64 = await fileToBase64(file);
      const data = await apiFetch("/api/analyze", { pdfBase64: base64 });
      const topics = (data.analysis?.topics || []).slice(0, 3);
      if (!topics.length) throw new Error("AI가 주제를 만들지 못했습니다.");
      const normalizedTopics = topics.map((t, idx) => ({
        ...t,
        timeLeft: TOPIC_SECONDS,
        turns: [],
        status: idx === 0 ? "active" : "pending",
        started: false,
        asked: false,
      }));
      setAssignment({ summary: data.analysis.summary, topics: normalizedTopics, text: data.text || "" });
      setTopicsState(normalizedTopics);
      setCurrentTopicIndex(0);
      await prepareTopic(0, normalizedTopics, data.analysis.summary, data.text || "");
    } catch (err) {
      console.error(err);
      setError(err.message || "업로드에 실패했습니다.");
      setPhase("upload");
    }
  };

  const prepareTopic = useCallback(async (index, nextTopics, summary, text) => {
    setPrepLabel(`${index + 1}번째 주제 준비중`);
    setPhase("prep");
    setModal(null);
    setAiGenerating(true);
    setStudentInput("");
    setIsTyping(false);
    try {
      const topic = nextTopics[index];
      const alreadyHasQuestion = (topic.turns || []).some((turn) => turn.role === "ai");
      if (topic.asked && alreadyHasQuestion) {
        setTopicsState((prev) =>
          prev.map((t, idx) => ({
            ...t,
            status: idx === index ? "active" : idx < index ? "done" : t.status,
          })),
        );
        setCurrentTopicIndex(index);
        setAiGenerating(false);
        setPhase("interview");
        return;
      }
      const question = await apiFetch("/api/question", {
        summary,
        topic,
        excerpt: (text || "").slice(0, 1500),
        previousQA: [],
        studentAnswer: "",
      });
      const questionText =
        (typeof question === "object" ? question.question : question) ||
        "주제와 관련된 내용을 더 자세히 설명해 주시겠어요?";
      setTopicsState((prev) =>
        prev.map((t, idx) => {
          if (idx === index) {
            const turns = [...(t.turns || []), { role: "ai", text: questionText }];
            return {
              ...t,
              turns,
              status: "active",
              timeLeft: t.timeLeft || TOPIC_SECONDS,
              started: true,
              asked: true,
            };
          }
          return { ...t, status: idx < index ? "done" : t.status };
        }),
      );
      setCurrentTopicIndex(index);
      setAiGenerating(false);
      setPhase("interview");
    } catch (err) {
      console.error(err);
      setError("첫 질문 생성에 실패했습니다. 다시 시도해 주세요.");
      setPhase("upload");
      setAiGenerating(false);
    }
  }, []);

  const handleSend = async () => {
    if (!studentInput.trim() || !currentTopic) return;
    const message = studentInput.trim();
    setStudentInput("");
    setIsTyping(false);

    let nextTurns = [];
    setTopicsState((prev) =>
      prev.map((t, idx) => {
        if (idx === currentTopicIndex) {
          nextTurns = [...(t.turns || []), { role: "student", text: message }];
          return { ...t, turns: nextTurns };
        }
        return t;
      }),
    );

    setAiGenerating(true);
    try {
      const question = await fetchQuestion({
        topic: currentTopic,
        previousQA: nextTurns,
        studentAnswer: message,
      });
      setTopicsState((prev) =>
        prev.map((t, idx) => {
          if (idx === currentTopicIndex) {
            return { ...t, turns: [...nextTurns, { role: "ai", text: question }] };
          }
          return t;
        }),
      );
    } catch (err) {
      console.error(err);
      setError("질문 생성에 실패했습니다. 다시 시도해 주세요.");
    } finally {
      setAiGenerating(false);
    }
  };

  const finalizeSession = useCallback(
    async (doneTopics) => {
      setPhase("finalizing");
      try {
        const transcript = buildTranscript(doneTopics);
        const data = await apiFetch("/api/summary", {
          transcript,
          summary: assignment.summary,
          topics: assignment.topics,
        });
        setResultSummary(data.summary);
      } catch (err) {
        console.error(err);
        setError("결과 요약에 실패했습니다. 다시 시도해 주세요.");
      } finally {
        setPhase("result");
        setAiGenerating(false);
      }
    },
    [assignment.summary, assignment.topics],
  );

  const triggerAutoModal = () => {
    setModal({ type: "auto-exit" });
    setAutoCountdown(AUTO_ADVANCE_SECONDS);
  };

  const completeTopic = useCallback(
    async (_reason) => {
      if (advancing) return;
      setAdvancing(true);
      setModal(null);
      setAiGenerating(false);
      setIsTyping(false);
      setStudentInput("");

      let updated = topicsState;
      setTopicsState((prev) => {
        updated = prev.map((t, idx) =>
          idx === currentTopicIndex
            ? { ...t, status: "done", timeLeft: Math.max(0, t.timeLeft) }
            : t,
        );
        return updated;
      });

      const nextIndex = currentTopicIndex + 1;
      if (nextIndex < topicsState.length) {
        await prepareTopic(nextIndex, updated, assignment.summary, assignment.text);
      } else {
        await finalizeSession(updated);
      }
      setAdvancing(false);
    },
    [advancing, topicsState, currentTopicIndex, assignment.summary, assignment.text, prepareTopic, finalizeSession],
  );

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

  const handleReset = () => {
    setPhase("upload");
    setAssignment({ summary: "", topics: [], text: "" });
    setTopicsState([]);
    setCurrentTopicIndex(0);
    setAiGenerating(false);
    setIsTyping(false);
    setStudentInput("");
    setError("");
    setModal(null);
    setResultSummary(null);
    setAdvancing(false);
  };

  return (
    <main className={styles.shell}>
      <div className={styles.backdrop} />
      <section className={styles.header}>
        <div>
          <p className={styles.eyebrow}>AI 과제 인터뷰 조교</p>
          <h1 className={styles.title}>Homework Validator</h1>
          <p className={styles.subtitle}>
            PDF 업로드 → 3개 주제 인터뷰 → 이해도 리포트. 로그인 없이 바로 시작하세요.
          </p>
        </div>
        <div className={styles.statusGroup}>
          <span className={styles.badge}>{phaseLabels[phase] || "대기"}</span>
          {phase === "interview" && (
            <span className={styles.badgeSecondary}>주제 {progressText} 진행중</span>
          )}
          {aiGenerating && <span className={styles.badgePulse}>AI 생성중</span>}
        </div>
      </section>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {phase === "upload" && <UploadCard onUpload={handleUpload} />}
      {phase === "analyzing" && (
        <LoadingCard
          label="과제 분석중"
          detail="AI가 과제의 요약과 주제 블록을 만드는 중입니다. 잠시만 기다려 주세요."
        />
      )}
      {phase === "prep" && (
        <LoadingCard
          label="인터뷰 준비중"
          detail={prepLabel || "첫 질문을 만들고 있어요."}
        />
      )}
      {phase === "interview" && currentTopic && (
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
      )}
      {phase === "finalizing" && (
        <LoadingCard
          label="결과 분석중"
          detail="대화 내용을 바탕으로 이해도와 소유감을 평가하고 있어요."
        />
      )}
      {phase === "result" && (
        <ResultCard summary={resultSummary} onReset={handleReset} />
      )}
    </main>
  );
}

function UploadCard({ onUpload }) {
  const [fileName, setFileName] = useState("");

  const handleFileSelect = (file) => {
    if (file) {
      setFileName(file.name);
      onUpload(file);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <p className={styles.cardEyebrow}>STEP 1</p>
          <h2 className={styles.cardTitle}>과제 PDF 업로드</h2>
          <p className={styles.cardDescription}>
            로그인 없이 즉시 업로드하세요. 업로드와 동시에 새로운 세션이 시작됩니다.
          </p>
        </div>
        <div className={styles.uploadHelper}>PDF만 허용 · 세션 저장 없음</div>
      </div>
      <label
        className={styles.uploadArea}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          handleFileSelect(file);
        }}
      >
        <input
          type="file"
          accept="application/pdf"
          className={styles.fileInput}
          onChange={(e) => {
            const file = e.target.files?.[0];
            handleFileSelect(file);
          }}
        />
        <div>
          <p className={styles.uploadTitle}>PDF를 끌어놓거나 클릭해 업로드</p>
          <p className={styles.uploadSub}>{fileName || "한글 과제만 지원하며, 업로드 후 바로 분석합니다."}</p>
        </div>
      </label>
    </div>
  );
}

function LoadingCard({ label, detail }) {
  return (
    <div className={styles.cardCenter}>
      <div className={styles.loader}>
        <span />
        <span />
        <span />
      </div>
      <h2 className={styles.loadingTitle}>{label}</h2>
      <p className={styles.loadingDetail}>{detail}</p>
    </div>
  );
}

function InterviewCard({
  topic,
  topics,
  currentIndex,
  progressText,
  timeText,
  onSend,
  studentInput,
  setStudentInput,
  onTyping,
  aiGenerating,
  modal,
  onManualExit,
  onConfirmExit,
  onCancelExit,
  autoCountdown,
  inputDisabled,
}) {
  return (
    <div className={styles.interviewGrid}>
      <div className={styles.topicPanel}>
        <div className={styles.topicHeader}>
          <p className={styles.cardEyebrow}>주제 {progressText}</p>
          <h2 className={styles.cardTitle}>{topic.title}</h2>
          <p className={styles.cardDescription}>{topic.description}</p>
        </div>
        <div className={styles.topicList}>
          {topics.map((t, idx) => (
            <div
              key={t.id || idx}
              className={clsx(styles.topicChip, {
                [styles.topicChipActive]: idx === currentIndex,
                [styles.topicChipDone]: t.status === "done",
              })}
            >
              <div className={styles.topicChipTitle}>{t.title}</div>
              <div className={styles.topicChipMeta}>
                {idx === currentIndex ? "진행중" : t.status === "done" ? "완료" : "대기"}
              </div>
            </div>
          ))}
        </div>
        <div className={styles.timerRow}>
          <div>
            <p className={styles.timerLabel}>남은 시간</p>
            <p className={styles.timerValue}>{timeText}</p>
            <p className={styles.timerHint}>
              {modal?.type === "manual-exit"
                ? "종료 확인 중에도 시간이 흘러요"
                : aiGenerating
                ? "AI 생성중: 타이머 일시정지"
                : "입력 중에만 시간이 차감됩니다"}
            </p>
          </div>
          <button className={styles.secondaryButton} onClick={onManualExit} disabled={modal?.type === "auto-exit"}>
            주제 종료 후 넘어가기
          </button>
        </div>
      </div>

      <div className={styles.chatPanel}>
        <div className={styles.chatHeader}>
          <span>인터뷰 대화</span>
          <span className={styles.badgeSecondary}>3분 제한 · 역방향 이동 불가</span>
        </div>
        <div className={styles.chatBody}>
          {topic.turns.map((turn, idx) => (
            <div
              key={idx}
              className={clsx(styles.chatBubble, turn.role === "ai" ? styles.chatAI : styles.chatStudent)}
            >
              <p className={styles.chatSender}>{turn.role === "ai" ? "AI" : "학생"}</p>
              <p>{turn.text}</p>
            </div>
          ))}
          {aiGenerating && (
            <div className={clsx(styles.chatBubble, styles.chatAI)}>
              <p className={styles.chatSender}>AI</p>
              <p className={styles.typingDots}>
                <span />
                <span />
                <span />
              </p>
            </div>
          )}
        </div>
        <div className={styles.chatInputArea}>
          <textarea
          value={studentInput}
          onChange={(e) => {
            setStudentInput(e.target.value);
            onTyping();
          }}
          placeholder="질문에 대해 자신의 말로 답변해 주세요."
          disabled={inputDisabled}
        />
          <div className={styles.chatActions}>
            <button className={styles.primaryButton} onClick={onSend} disabled={inputDisabled}>
              전송
            </button>
            <span className={styles.timerMicro}>{timeText}</span>
          </div>
        </div>
      </div>

      {modal?.type && (
        <div className={styles.modalOverlay}>
          <div className={styles.modalCard}>
            {modal.type === "manual-exit" ? (
              <>
                <h3>다음 주제로 넘어갈까요?</h3>
                <p>이전 주제로 돌아올 수 없으며, 확인하는 동안에도 시간이 계속 차감됩니다.</p>
                <div className={styles.modalActions}>
                  <button className={styles.secondaryButton} onClick={onCancelExit}>
                    계속 진행
                  </button>
                  <button className={styles.primaryButton} onClick={onConfirmExit}>
                    넘어가기
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>시간이 종료되었습니다</h3>
                <p>다음 주제로 이동합니다. {autoCountdown}초 후 자동 진행.</p>
                <div className={styles.modalActions}>
                  <button className={styles.primaryButton} onClick={onConfirmExit}>
                    바로 넘어가기
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultCard({ summary, onReset }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <p className={styles.cardEyebrow}>인터뷰 결과</p>
          <h2 className={styles.cardTitle}>이해도 리포트</h2>
          <p className={styles.cardDescription}>대화 내용을 바탕으로 학생의 강점과 개선점을 정리했어요.</p>
        </div>
        <button className={styles.secondaryButton} onClick={onReset}>
          새 과제로 시작
        </button>
      </div>
      {summary ? (
        <div className={styles.resultGrid}>
          <div className={styles.resultBlock}>
            <p className={styles.cardEyebrow}>강점</p>
            <ul>
              {summary.strengths?.length
                ? summary.strengths.map((item, idx) => <li key={idx}>{item}</li>)
                : <li>강점 정보가 없습니다.</li>}
            </ul>
          </div>
          <div className={styles.resultBlock}>
            <p className={styles.cardEyebrow}>개선이 필요한 부분</p>
            <ul>
              {summary.weaknesses?.length
                ? summary.weaknesses.map((item, idx) => <li key={idx}>{item}</li>)
                : <li>개선점 정보가 없습니다.</li>}
            </ul>
          </div>
          <div className={styles.resultBlockWide}>
            <p className={styles.cardEyebrow}>종합 코멘트</p>
            <p>{summary.overallComment}</p>
          </div>
        </div>
      ) : (
        <p className={styles.cardDescription}>결과를 불러오지 못했습니다. 새 과제로 다시 시작해 주세요.</p>
      )}
    </div>
  );
}
