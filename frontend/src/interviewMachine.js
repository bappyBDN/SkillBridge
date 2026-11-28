/**
 * Pure state machine for the voice AI interview.
 *
 * Hard rules encoded here (not by convention):
 *  - The AI can only enter ASKING from IDLE/ERROR (a loaded question), never
 *    while the candidate is LISTENING. Any stray "question_loaded"/"tts_start"
 *    event during LISTENING is ignored.
 *  - LISTENING ends only when the candidate clicks Done or the silence
 *    countdown finishes. No-speech for 20s never advances.
 *  - The 5-second silence countdown is cancellable by "keep_speaking".
 *  - The 3-minute hard cap forces submission; a warning appears at 2:30.
 *
 * No React, timers or browser APIs here: the hook owns effects, tests call
 * reduce() directly with an explicit `now`.
 */

export const PHASES = Object.freeze({
  IDLE: "idle",
  ASKING: "asking",
  LISTENING: "listening",
  CONFIRM: "confirm",
  SUBMITTING: "submitting",
  FINISHED: "finished",
  ERROR: "error",
});

export const SILENCE_MS = 6000;
export const COUNTDOWN_MS = 5000;
export const NO_SPEECH_MS = 20000;
export const CAP_WARNING_MS = 150000;
export const HARD_CAP_MS = 180000;
export const MIN_ANSWER_MS = 0;

export function initialInterviewState() {
  return {
    phase: PHASES.IDLE,
    question: null,
    questionCount: 0,
    maxQuestions: 0,
    speechDetected: false,
    lastSpeechAt: null,
    answerStartedAt: null,
    wakePrompt: false,
    capWarning: false,
    countdownRemaining: 0,
    countdownEndsAt: null,
    countdownReason: null,
    error: null,
    notice: "",
    finished: false,
    submittedAt: null,
    ttsUnavailable: false,
  };
}

function resetAnswer(state, extra = {}) {
  return {
    ...state,
    speechDetected: false,
    lastSpeechAt: null,
    answerStartedAt: null,
    wakePrompt: false,
    capWarning: false,
    countdownRemaining: 0,
    countdownEndsAt: null,
    countdownReason: null,
    error: null,
    ...extra,
  };
}

function beginQuestion(state, event) {
  const question = event.question || null;
  if (!question) return state;
  return resetAnswer(state, {
    phase: PHASES.ASKING,
    question,
    questionCount: Number(
      event.questionCount ?? question.turn_no ?? state.questionCount + 1,
    ),
    maxQuestions: Number(event.maxQuestions ?? state.maxQuestions ?? 0),
    finished: false,
    notice: "",
    ttsUnavailable: false,
  });
}

function listening(state, now) {
  return {
    ...state,
    phase: PHASES.LISTENING,
    answerStartedAt: now,
    lastSpeechAt: null,
    speechDetected: false,
    wakePrompt: false,
    capWarning: false,
    countdownRemaining: 0,
    countdownEndsAt: null,
    countdownReason: null,
  };
}

function enterConfirm(state, now, reason) {
  return {
    ...state,
    phase: PHASES.CONFIRM,
    countdownReason: reason,
    countdownEndsAt: now + COUNTDOWN_MS,
    countdownRemaining: COUNTDOWN_MS,
    wakePrompt: false,
  };
}

function tick(state, now, blocked = false) {
  if (state.phase === PHASES.LISTENING) {
    const started = Number(state.answerStartedAt ?? now);
    const elapsed = Math.max(0, now - started);
    let next = state;
    if (!state.capWarning && elapsed >= CAP_WARNING_MS) {
      next = { ...next, capWarning: true };
    }
    // The hard cap continues even while a proctor overlay is covering the UI.
    if (elapsed >= HARD_CAP_MS) {
      return { ...next, phase: PHASES.SUBMITTING, countdownReason: "cap", countdownRemaining: 0 };
    }
    // While blocked (fullscreen/camera lost) the AI stays silent: no silence
    // countdown and no "still there?" prompt. Recording and the cap continue.
    if (blocked) return next;
    if (!state.speechDetected) {
      if (!state.wakePrompt && elapsed >= NO_SPEECH_MS) {
        return { ...next, wakePrompt: true };
      }
      return next;
    }
    if (state.lastSpeechAt != null && now - Number(state.lastSpeechAt) >= SILENCE_MS) {
      return enterConfirm(next, now, "silence");
    }
    return next;
  }
  if (state.phase === PHASES.CONFIRM) {
    if (blocked) return state;
    const endsAt = Number(state.countdownEndsAt ?? now);
    const remaining = Math.max(0, endsAt - now);
    if (remaining <= 0) {
      return {
        ...state,
        phase: PHASES.SUBMITTING,
        countdownRemaining: 0,
        countdownReason: state.countdownReason || "silence",
      };
    }
    return { ...state, countdownRemaining: remaining };
  }
  return state;
}

export function reduce(state, event) {
  if (!state || !event) return state;
  const now = Number(event.now ?? 0);

  switch (event.type) {
    // The only way into ASKING. Guarded so a stray server/LLM event can never
    // talk over the candidate.
    case "question_loaded":
      if (state.phase !== PHASES.IDLE && state.phase !== PHASES.ERROR) return state;
      return beginQuestion(state, event);

    case "start_question":
      if (state.phase !== PHASES.IDLE || !state.question) return state;
      return resetAnswer(state, { phase: PHASES.ASKING, error: null, notice: "" });

    case "tts_end":
    case "skip_reading":
      if (state.phase !== PHASES.ASKING) return state;
      return listening(state, now);

    case "tts_unavailable":
      if (state.phase !== PHASES.ASKING) return state;
      return { ...listening(state, now), ttsUnavailable: true };

    // Live preview/analyser noise only counts while the microphone is on.
    case "speech_detected":
      if (state.phase !== PHASES.LISTENING) return state;
      return {
        ...state,
        speechDetected: true,
        lastSpeechAt: now,
        wakePrompt: false,
      };

    case "tick":
      return tick(state, now, Boolean(event.blocked));

    case "resume":
      // Returning from a proctor overlay restarts the silence/countdown clocks
      // without resetting the 3-minute answer cap.
      if (state.phase === PHASES.LISTENING) {
        return {
          ...state,
          lastSpeechAt: state.speechDetected ? now : state.lastSpeechAt,
          wakePrompt: false,
        };
      }
      if (state.phase === PHASES.CONFIRM) {
        return {
          ...state,
          countdownEndsAt: now + Number(state.countdownRemaining || 0),
        };
      }
      return state;

    case "done":
      if (state.phase !== PHASES.LISTENING) return state;
      return { ...state, phase: PHASES.SUBMITTING, countdownReason: "manual", countdownRemaining: 0 };

    case "still_here":
      if (state.phase !== PHASES.LISTENING) return state;
      return { ...state, wakePrompt: false };

    case "keep_speaking":
      if (state.phase !== PHASES.CONFIRM) return state;
      return {
        ...state,
        phase: PHASES.LISTENING,
        countdownRemaining: 0,
        countdownEndsAt: null,
        countdownReason: null,
        speechDetected: true,
        lastSpeechAt: now,
        wakePrompt: false,
      };

    case "submitted": {
      if (state.phase !== PHASES.SUBMITTING) return state;
      if (event.finished) {
        return {
          ...state,
          phase: PHASES.FINISHED,
          finished: true,
          question: null,
          submittedAt: event.submittedAt ?? now,
          countdownReason: null,
        };
      }
      // Paused between questions: the next question is shown as text and the
      // microphone stays off until the candidate starts it.
      const next = resetAnswer(state, {
        phase: PHASES.IDLE,
        question: event.question || null,
        submittedAt: event.submittedAt ?? state.submittedAt,
        notice: "Answer saved. Pause here if you need to; the deadline still applies.",
      });
      next.questionCount = Number(
        event.questionCount ?? event.question?.turn_no ?? state.questionCount + 1,
      );
      next.maxQuestions = Number(event.maxQuestions ?? state.maxQuestions ?? 0);
      return next;
    }

    case "submit_failed":
      if (state.phase !== PHASES.SUBMITTING) return state;
      return {
        ...state,
        phase: PHASES.ERROR,
        error: event.error || "Could not save this answer.",
        countdownReason: null,
      };

    case "retry":
      if (state.phase !== PHASES.ERROR) return state;
      return { ...state, phase: PHASES.SUBMITTING, error: null };

    case "finish_notice":
      return { ...state, notice: event.notice || "" };

    default:
      return state;
  }
}

/** Milliseconds until a deadline; 0 when passed. */
export function deadlineRemaining(deadlineAt, now = Date.now()) {
  const end = Number(deadlineAt) * 1000;
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, end - now);
}

/** "2d 4h", "3h 10m", "45m", "1m 5s" or "Expired". */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "Expired";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** True only when the invite is open and before its deadline. */
export function canStartInterview(invite, now = Date.now()) {
  const status = String(invite?.status || "").toLowerCase();
  if (!["invited", "in_progress"].includes(status)) return false;
  return deadlineRemaining(invite?.deadline_at, now) > 0;
}
