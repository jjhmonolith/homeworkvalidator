"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4010";

export function useWhisperRecognition() {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState(null);
  const [volumeLevel, setVolumeLevel] = useState(0);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const mediaStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(null);
  const contextRef = useRef("");

  const stopVolumeMonitoring = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current = null;
    }
    setVolumeLevel(0);
  }, []);

  const cleanup = useCallback(() => {
    stopVolumeMonitoring();
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
  }, [stopVolumeMonitoring]);

  const startListening = useCallback(async (context = "") => {
    contextRef.current = context;
    audioChunksRef.current = [];
    setTranscript("");
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setVolumeLevel(Math.min(average / 128, 1));
        animationFrameRef.current = requestAnimationFrame(updateVolume);
      };
      updateVolume();

      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start(1000);
      setIsListening(true);
    } catch (err) {
      setError("마이크 권한이 필요합니다.");
      console.error("Microphone access error:", err);
    }
  }, []);

  const stopListening = useCallback(async () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      return "";
    }

    setIsListening(false);
    setIsTranscribing(true);
    stopVolumeMonitoring();

    return new Promise((resolve) => {
      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        
        if (audioBlob.size < 1000) {
          setIsTranscribing(false);
          cleanup();
          resolve("");
          return;
        }

        try {
          const formData = new FormData();
          formData.append("audio", audioBlob, "recording.webm");
          formData.append("context", contextRef.current);

          const response = await fetch(`${API_BASE}/api/stt`, {
            method: "POST",
            body: formData,
          });

          if (!response.ok) {
            throw new Error("STT request failed");
          }

          const data = await response.json();
          const text = data.text || "";
          setTranscript(text);
          resolve(text);
        } catch (err) {
          console.error("STT error:", err);
          setError("음성 인식에 실패했습니다.");
          resolve("");
        } finally {
          setIsTranscribing(false);
          cleanup();
        }
      };

      mediaRecorderRef.current.stop();
    });
  }, [stopVolumeMonitoring, cleanup]);

  const resetTranscript = useCallback(() => {
    setTranscript("");
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return {
    isListening,
    isTranscribing,
    transcript,
    error,
    isSupported: true,
    volumeLevel,
    startListening,
    stopListening,
    resetTranscript,
  };
}

export function useSpeechSynthesis() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSupported] = useState(true);
  const audioRef = useRef(null);
  const abortControllerRef = useRef(null);
  const requestIdRef = useRef(0);

  const speak = useCallback(async (text, validationFn) => {
    if (!text) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    const currentRequestId = ++requestIdRef.current;
    abortControllerRef.current = new AbortController();
    setIsSpeaking(true);

    try {
      const response = await fetch(`${API_BASE}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: abortControllerRef.current.signal,
      });

      if (currentRequestId !== requestIdRef.current) {
        setIsSpeaking(false);
        return;
      }

      if (validationFn && !validationFn()) {
        setIsSpeaking(false);
        return;
      }

      if (!response.ok) {
        throw new Error("TTS request failed");
      }

      const blob = await response.blob();
      
      if (currentRequestId !== requestIdRef.current) {
        setIsSpeaking(false);
        return;
      }

      if (validationFn && !validationFn()) {
        setIsSpeaking(false);
        return;
      }

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(url);
      };

      await audio.play();
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("TTS error:", err);
      }
      setIsSpeaking(false);
    }
  }, []);

  const stop = useCallback(() => {
    requestIdRef.current++;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setIsSpeaking(false);
  }, []);

  return {
    isSpeaking,
    isSupported,
    speak,
    stop,
  };
}
