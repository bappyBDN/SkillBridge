import { useCallback, useEffect, useReducer, useRef } from "react";
import { PHASES, initialInterviewState, reduce } from "./interviewMachine.js";

/**
 * React wrapper around the pure machine. All timers live here; the page never
 * runs its own silence/countdown clocks, so the rules are enforced in one place.
 * `blocked` (a fullscreen/camera overlay) freezes silence logic while the
 * 3-minute cap and recording continue.
 */
export default function useInterviewMachine(blocked = false) {
  const [state, dispatch] = useReducer(reduce, undefined, initialInterviewState);
  const blockedRef = useRef(blocked);
  const previousBlocked = useRef(blocked);
  blockedRef.current = blocked;

  useEffect(() => {
    if (state.phase !== PHASES.LISTENING && state.phase !== PHASES.CONFIRM) return undefined;
    const timer = setInterval(() => {
      dispatch({ type: "tick", now: Date.now(), blocked: blockedRef.current });
    }, 200);
    return () => clearInterval(timer);
  }, [state.phase]);

  useEffect(() => {
    if (previousBlocked.current && !blocked) {
      dispatch({ type: "resume", now: Date.now() });
    }
    previousBlocked.current = blocked;
  }, [blocked]);

  const loadQuestion = useCallback((question, options = {}) => {
    dispatch({ type: "question_loaded", question, now: Date.now(), ...options });
  }, []);
  const startQuestion = useCallback(() => {
    dispatch({ type: "start_question", now: Date.now() });
  }, []);
  const finishReading = useCallback(() => {
    dispatch({ type: "tts_end", now: Date.now() });
  }, []);
  const skipReading = useCallback(() => {
    dispatch({ type: "skip_reading", now: Date.now() });
  }, []);
  const ttsUnavailable = useCallback(() => {
    dispatch({ type: "tts_unavailable", now: Date.now() });
  }, []);
  const markSpeech = useCallback(() => {
    dispatch({ type: "speech_detected", now: Date.now() });
  }, []);
  const submitNow = useCallback(() => {
    dispatch({ type: "done", now: Date.now() });
  }, []);
  const keepSpeaking = useCallback(() => {
    dispatch({ type: "keep_speaking", now: Date.now() });
  }, []);
  const stillHere = useCallback(() => {
    dispatch({ type: "still_here", now: Date.now() });
  }, []);
  const submitted = useCallback((payload) => {
    dispatch({ type: "submitted", now: Date.now(), ...payload });
  }, []);
  const submitFailed = useCallback((error) => {
    dispatch({ type: "submit_failed", error, now: Date.now() });
  }, []);
  const retry = useCallback(() => {
    dispatch({ type: "retry", now: Date.now() });
  }, []);

  return {
    state,
    dispatch,
    loadQuestion,
    startQuestion,
    finishReading,
    skipReading,
    ttsUnavailable,
    markSpeech,
    submitNow,
    keepSpeaking,
    stillHere,
    submitted,
    submitFailed,
    retry,
  };
}
