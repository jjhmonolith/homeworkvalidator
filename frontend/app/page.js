"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import clsx from "clsx";
import styles from "./page.module.css";
import { useWhisperRecognition, useSpeechSynthesis } from "./hooks/useSpeech";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4010";
const AUTO_ADVANCE_SECONDS = 5;

const phaseLabels = {
  upload: "인터뷰 설정",
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

function buildContextForSTT(assignmentText, turns) {
  const excerpt = (assignmentText || "").slice(0, 200);
  const recentQA = (turns || []).slice(-2).map(t => t.text).join(" ");
  return `${excerpt} ${recentQA}`.trim();
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
  const [interviewMode, setInterviewMode] = useState(null);
  const [turnSubmitted, setTurnSubmitted] = useState(false);
  const [settings, setSettings] = useState({ topicCount: 3, topicDuration: 180 });

  const currentTopic = topicsState[currentTopicIndex];

  const {
    isListening,
    isTranscribing,
    transcript,
    error: speechError,
    isSupported: sttSupported,
    volumeLevel,
    startListening,
    stopListening,
    resetTranscript,
  } = useWhisperRecognition();

  const {
    isSpeaking,
    isSupported: ttsSupported,
    speak,
    stop: stopSpeaking,
  } = useSpeechSynthesis({ lang: "ko-KR", rate: 0.95 });

  useEffect(() => {
    if (!isTyping) return;
    const timer = setTimeout(() => setIsTyping(false), 5000);
    return () => clearTimeout(timer);
  }, [isTyping]);

  const prevTurnsLengthRef = useRef(0);
  const prevSpeakingRef = useRef(false);

  useEffect(() => {
    if (interviewMode === "voice" && transcript) {
      setStudentInput(transcript);
    }
  }, [interviewMode, transcript]);

  const prevTopicIndexRef = useRef(currentTopicIndex);
  const phaseRef = useRef(phase);
  const topicIndexRef = useRef(currentTopicIndex);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    topicIndexRef.current = currentTopicIndex;
  }, [currentTopicIndex]);

  useEffect(() => {
    if (currentTopicIndex !== prevTopicIndexRef.current) {
      prevTurnsLengthRef.current = 0;
      prevTopicIndexRef.current = currentTopicIndex;
      stopSpeaking();
    }
  }, [currentTopicIndex, stopSpeaking]);

  useEffect(() => {
    if (interviewMode !== "voice" || aiGenerating || phase !== "interview") return;
    const turns = currentTopic?.turns || [];
    const lastTurn = turns[turns.length - 1];
    if (turns.length > prevTurnsLengthRef.current && lastTurn?.role === "ai") {
      setTurnSubmitted(false);
      const expectedTopicIndex = currentTopicIndex;
      speak(lastTurn.text, () => {
        return phaseRef.current === "interview" && topicIndexRef.current === expectedTopicIndex;
      });
    }
    prevTurnsLengthRef.current = turns.length;
  }, [currentTopic?.turns, interviewMode, aiGenerating, phase, currentTopicIndex, speak, stopSpeaking]);

  useEffect(() => {
    if (interviewMode !== "voice") return;
    if (phase !== "interview") return;
    if (prevSpeakingRef.current && !isSpeaking && !turnSubmitted && !aiGenerating) {
      resetTranscript();
      const context = buildContextForSTT(assignment.text, currentTopic?.turns || []);
      startListening(context);
    }
    prevSpeakingRef.current = isSpeaking;
  }, [isSpeaking, interviewMode, phase, turnSubmitted, aiGenerating, resetTranscript, startListening, assignment.text, currentTopic?.turns]);

  useEffect(() => {
    if (phase !== "interview" && interviewMode === "voice") {
      stopListening();
      stopSpeaking();
    }
  }, [phase, interviewMode, stopListening, stopSpeaking]);

  useEffect(() => {
    if (phase !== "interview") return;
    if (!currentTopic) return;
    if (currentTopic.timeLeft <= 0) return;

    const shouldTick =
      modal?.type === "manual-exit" ||
      ((isTyping || currentTopic.started) && !aiGenerating && !isSpeaking && modal?.type !== "auto-exit");
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
  }, [phase, currentTopicIndex, currentTopic, isTyping, aiGenerating, isSpeaking, modal]);

  useEffect(() => {
    if (phase !== "interview") return;
    if (!currentTopic) return;
    if (currentTopic.timeLeft > 0) return;
    if (modal?.type === "auto-exit" || advancing) return;
    triggerAutoModal();
  }, [phase, currentTopic, modal, advancing]);

  const progressText = topicsState.length ? `${currentTopicIndex + 1}/${topicsState.length}` : "";

  const inputDisabled = phase !== "interview" || aiGenerating || modal?.type === "auto-exit";

  const fetchQuestion = useCallback(async ({ topic, previousQA, studentAnswer }) => {
    const data = await apiFetch("/api/question", {
      topic,
      assignmentText: assignment.text || "",
      previousQA,
      studentAnswer,
      interviewMode: interviewMode || "chat",
    });
    return data.question || "이 부분을 왜 이렇게 작성하셨나요?";
  }, [assignment.text, interviewMode]);

  const handleStart = async (file, { topicCount, topicDuration, interviewMode: mode }) => {
    if (!file) {
      setError("PDF 파일을 선택해 주세요.");
      return;
    }
    
    setError("");
    setInterviewMode(mode);
    setSettings({ topicCount, topicDuration });
    setPhase("analyzing");
    
    try {
      const base64 = await fileToBase64(file);
      const data = await apiFetch("/api/analyze", { pdfBase64: base64 });
      const allTopics = (data.analysis?.topics || []).slice(0, 5);
      if (!allTopics.length) throw new Error("AI가 주제를 만들지 못했습니다.");
      
      const selectedTopics = allTopics.slice(0, topicCount);
      const normalizedTopics = selectedTopics.map((t, idx) => ({
        ...t,
        timeLeft: topicDuration,
        turns: [],
        status: idx === 0 ? "active" : "pending",
        started: false,
        asked: false,
      }));
      
      setAssignment({ topics: normalizedTopics, text: data.text || "" });
      setTopicsState(normalizedTopics);
      setCurrentTopicIndex(0);
      await prepareTopic(0, normalizedTopics, data.text || "");
    } catch (err) {
      console.error(err);
      setError(err.message || "업로드에 실패했습니다.");
      setPhase("upload");
    }
  };

  const prepareTopic = useCallback(async (index, nextTopics, text) => {
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
        topic,
        assignmentText: text || "",
        previousQA: [],
        studentAnswer: "",
      });
      const questionText =
        (typeof question === "object" ? question.question : question) ||
        "이 부분을 왜 이렇게 작성하셨나요?";
      setTopicsState((prev) =>
        prev.map((t, idx) => {
          if (idx === index) {
            const turns = [...(t.turns || []), { role: "ai", text: questionText }];
            return {
              ...t,
              turns,
              status: "active",
              timeLeft: t.timeLeft,
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

  const handleVoiceSubmit = useCallback(async () => {
    if (turnSubmitted || !currentTopic || isTranscribing) return;
    setTurnSubmitted(true);
    
    const transcribedText = await stopListening();
    const message = transcribedText.trim();
    const studentResponse = message || "(응답 없음)";
    
    resetTranscript();
    setStudentInput("");

    let nextTurns = [];
    setTopicsState((prev) =>
      prev.map((t, idx) => {
        if (idx === currentTopicIndex) {
          nextTurns = [...(t.turns || []), { role: "student", text: studentResponse }];
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
        studentAnswer: studentResponse,
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
  }, [turnSubmitted, isTranscribing, currentTopic, currentTopicIndex, stopListening, resetTranscript, fetchQuestion]);

  const finalizeSession = useCallback(
    async (doneTopics) => {
      setPhase("finalizing");
      try {
        const transcriptText = buildTranscript(doneTopics);
        const data = await apiFetch("/api/summary", {
          transcript: transcriptText,
          topics: assignment.topics,
          assignmentText: assignment.text || "",
          interviewMode: interviewMode || "chat",
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
    [assignment.topics, assignment.text, interviewMode],
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
      stopSpeaking();
      stopListening();
      resetTranscript();

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
        await prepareTopic(nextIndex, updated, assignment.text);
      } else {
        await finalizeSession(updated);
      }
      setAdvancing(false);
    },
    [advancing, topicsState, currentTopicIndex, assignment.text, prepareTopic, finalizeSession, stopSpeaking, stopListening, resetTranscript],
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
    stopListening();
    stopSpeaking();
    setPhase("upload");
    setAssignment({ topics: [], text: "" });
    setTopicsState([]);
    setCurrentTopicIndex(0);
    setAiGenerating(false);
    setIsTyping(false);
    setStudentInput("");
    setError("");
    setModal(null);
    setResultSummary(null);
    setAdvancing(false);
    setInterviewMode(null);
    setTurnSubmitted(false);
    setSettings({ topicCount: 3, topicDuration: 180 });
    resetTranscript();
  };

  return (
    <main className={styles.shell}>
      <div className={styles.backdrop} />
      <section className={styles.header}>
        <div>
          <p className={styles.eyebrow}>AI 과제 인터뷰 조교</p>
          <h1 className={styles.title}>Homework Validator</h1>
          <p className={styles.subtitle}>
            PDF 업로드 → AI 인터뷰 → 이해도 리포트. 로그인 없이 바로 시작하세요.
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

      {phase === "upload" && <UploadCard onStart={handleStart} sttSupported={sttSupported} />}
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
          interviewMode={interviewMode}
          isListening={isListening}
          isTranscribing={isTranscribing}
          isSpeaking={isSpeaking}
          speechError={speechError}
          turnSubmitted={turnSubmitted}
          volumeLevel={volumeLevel}
          onVoiceSubmit={handleVoiceSubmit}
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

function UploadCard({ onStart, sttSupported }) {
  const [file, setFile] = useState(null);
  const [topicCount, setTopicCount] = useState(3);
  const [topicDuration, setTopicDuration] = useState(180);
  const [interviewMode, setInterviewMode] = useState("voice");

  const handleFileSelect = (selectedFile) => {
    if (selectedFile && selectedFile.type === "application/pdf") {
      setFile(selectedFile);
    }
  };

  const handleStart = () => {
    if (!file) return;
    onStart(file, { topicCount, topicDuration, interviewMode });
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <p className={styles.cardEyebrow}>인터뷰 설정</p>
          <h2 className={styles.cardTitle}>과제 PDF 업로드</h2>
          <p className={styles.cardDescription}>
            PDF를 업로드하고 설정을 선택한 후 인터뷰를 시작하세요.
          </p>
        </div>
      </div>

      <label
        className={clsx(styles.uploadArea, file && styles.uploadAreaSelected)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFileSelect(e.dataTransfer.files?.[0]);
        }}
      >
        <input
          type="file"
          accept="application/pdf"
          className={styles.fileInput}
          onChange={(e) => handleFileSelect(e.target.files?.[0])}
        />
        <div>
          <p className={styles.uploadTitle}>
            {file ? `✓ ${file.name}` : "PDF를 끌어놓거나 클릭해 업로드"}
          </p>
          <p className={styles.uploadSub}>
            {file ? "다른 파일을 선택하려면 다시 클릭하세요" : "PDF만 허용"}
          </p>
        </div>
      </label>

      <div className={styles.settingsSection}>
        <div className={styles.settingRow}>
          <label className={styles.settingLabel}>주제 개수</label>
          <div className={styles.settingButtons}>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                className={clsx(styles.settingButton, topicCount === n && styles.settingButtonActive)}
                onClick={() => setTopicCount(n)}
              >
                {n}개
              </button>
            ))}
          </div>
        </div>
        <div className={styles.settingRow}>
          <label className={styles.settingLabel}>주제별 제한 시간</label>
          <div className={styles.settingButtons}>
            {[60, 120, 180].map((sec) => (
              <button
                key={sec}
                className={clsx(styles.settingButton, topicDuration === sec && styles.settingButtonActive)}
                onClick={() => setTopicDuration(sec)}
              >
                {sec / 60}분
              </button>
            ))}
          </div>
        </div>
        <div className={styles.settingRow}>
          <label className={styles.settingLabel}>인터뷰 방식</label>
          <div className={styles.settingButtons}>
            <button
              className={clsx(styles.settingButton, interviewMode === "chat" && styles.settingButtonActive)}
              onClick={() => setInterviewMode("chat")}
            >
              💬 채팅
            </button>
            <button
              className={clsx(styles.settingButton, interviewMode === "voice" && styles.settingButtonActive, !sttSupported && styles.settingButtonDisabled)}
              onClick={() => sttSupported && setInterviewMode("voice")}
              disabled={!sttSupported}
            >
              🎤 음성
            </button>
          </div>
        </div>
      </div>

      <button
        className={styles.primaryButton}
        style={{ width: "100%", padding: "14px", fontSize: "16px" }}
        onClick={handleStart}
        disabled={!file}
      >
        인터뷰 시작
      </button>
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
  interviewMode,
  isListening,
  isTranscribing,
  isSpeaking,
  speechError,
  turnSubmitted,
  volumeLevel,
  onVoiceSubmit,
}) {
  const isVoiceMode = interviewMode === "voice";
  const volumeScale = 1 + volumeLevel * 0.5;
  return (
    <div className={styles.interviewGrid}>
      <div className={styles.topicPanel}>
        <div className={styles.topicHeader}>
          <p className={styles.cardEyebrow}>주제 {progressText}</p>
          <h2 className={styles.cardTitle}>{topic.title}</h2>
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
                : isSpeaking
                ? "AI 발화중: 타이머 일시정지"
                : "입력 중에만 시간이 차감됩니다"}
            </p>
          </div>
          <button className={styles.secondaryButton} onClick={onManualExit} disabled={modal?.type === "auto-exit"}>
            주제 종료 후 넘어가기
          </button>
        </div>
      </div>

      {isVoiceMode ? (
        <div className={styles.voicePanel}>
          <div className={styles.voiceHeader}>
            <span>음성 인터뷰</span>
            <span className={styles.badgeSecondary}>3분 제한 · 음성으로만 답변</span>
          </div>
          <div className={styles.voiceQuestionArea}>
            {aiGenerating ? (
              <div className={styles.voiceGenerating}>
                <div className={styles.typingDots}>
                  <span />
                  <span />
                  <span />
                </div>
                <p>AI가 질문을 준비하고 있습니다...</p>
              </div>
            ) : isSpeaking ? (
              <div className={styles.voiceGenerating}>
                <span className={styles.speakingIndicatorLarge}>🔊</span>
                <p>AI가 질문을 읽고 있습니다...</p>
              </div>
            ) : isTranscribing ? (
              <div className={styles.voiceGenerating}>
                <div className={styles.typingDots}>
                  <span />
                  <span />
                  <span />
                </div>
                <p>음성을 텍스트로 변환 중...</p>
              </div>
            ) : turnSubmitted ? (
              <div className={styles.voiceGenerating}>
                <p>답변이 제출되었습니다. 다음 질문을 기다려주세요.</p>
              </div>
            ) : (
              <div className={styles.voiceGenerating}>
                <div 
                  className={styles.volumeIndicator}
                  style={{ transform: `scale(${volumeScale})` }}
                >
                  <span className={styles.volumeInner}>🎙️</span>
                </div>
                <p>{isListening ? "듣고 있습니다..." : "마이크 준비 중..."}</p>
              </div>
            )}
          </div>
          <div className={styles.voiceResponseArea}>
            {speechError && <div className={styles.speechError}>{speechError}</div>}
            <button
              className={clsx(styles.micButtonLarge, styles.micButtonStop)}
              onClick={onVoiceSubmit}
              disabled={inputDisabled || aiGenerating || isSpeaking || turnSubmitted || isTranscribing}
            >
              ⏹️ 답변 완료
            </button>
          </div>
        </div>
      ) : (
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
              onPaste={(e) => e.preventDefault()}
              onDrop={(e) => e.preventDefault()}
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
      )}

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
        <p className={styles.cardDescription}>결과를 불러오지 못했습니다. 새 과제로 다시 시도해 주세요.</p>
      )}
    </div>
  );
}


