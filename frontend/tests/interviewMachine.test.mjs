import assert from "node:assert/strict";
import test from "node:test";

import {
  CAP_WARNING_MS,
  COUNTDOWN_MS,
  HARD_CAP_MS,
  NO_SPEECH_MS,
  PHASES,
  SILENCE_MS,
  canStartInterview,
  deadlineRemaining,
  formatRemaining,
  initialInterviewState,
  reduce,
} from "../src/interviewMachine.js";

const T0 = 1_000_000;
const QUESTION = {
  turn_id: "turn-1",
  turn_no: 1,
  text: "Tell me about your most recent project.",
  kind: "opening",
  topic: "Recent work",
};

function loaded(now = T0) {
  return reduce(initialInterviewState(), {
    type: "question_loaded",
    question: QUESTION,
    questionCount: 1,
    maxQuestions: 10,
    now,
  });
}

function asking(now = T0) {
  return loaded(now);
}

function listening(now = T0) {
  return reduce(asking(now), { type: "tts_end", now });
}

function speak(state, now) {
  return reduce(state, { type: "speech_detected", now });
}

test("the AI can never enter ASKING while the candidate is LISTENING", () => {
  const state = listening();
  assert.equal(state.phase, PHASES.LISTENING);

  const strayQuestion = reduce(state, {
    type: "question_loaded",
    question: { ...QUESTION, turn_id: "turn-2", text: "A new question the AI tried to ask" },
    now: T0 + 1000,
  });
  assert.strictEqual(strayQuestion, state, "question_loaded must be ignored");

  const strayStart = reduce(state, { type: "start_question", now: T0 + 1000 });
  assert.strictEqual(strayStart, state, "start_question must be ignored");

  const strayTts = reduce(state, { type: "tts_end", now: T0 + 1000 });
  assert.strictEqual(strayTts.phase, PHASES.LISTENING);
});

test("ASKING keeps the microphone off and ignores speech", () => {
  const state = asking();
  assert.equal(state.phase, PHASES.ASKING);
  const noisy = reduce(state, { type: "speech_detected", now: T0 + 500 });
  assert.strictEqual(noisy.phase, PHASES.ASKING);
  assert.equal(noisy.speechDetected, false);
  const after = reduce(noisy, { type: "tick", now: T0 + 20000 });
  assert.equal(after.phase, PHASES.ASKING, "ASKING has no listening clock");
});

test("TTs end enters LISTENING and starts the answer clock", () => {
  const state = reduce(asking(), { type: "tts_end", now: T0 + 4000 });
  assert.equal(state.phase, PHASES.LISTENING);
  assert.equal(state.answerStartedAt, T0 + 4000);
  assert.equal(state.speechDetected, false);
});

test("silence after speech opens a cancellable 5-second countdown", () => {
  let state = listening();
  state = speak(state, T0 + 3000);
  assert.equal(state.speechDetected, true);

  const early = reduce(state, { type: "tick", now: T0 + 3000 + SILENCE_MS - 500 });
  assert.equal(early.phase, PHASES.LISTENING);

  const confirm = reduce(state, { type: "tick", now: T0 + 3000 + SILENCE_MS });
  assert.equal(confirm.phase, PHASES.CONFIRM);
  assert.equal(confirm.countdownRemaining, COUNTDOWN_MS);
  assert.equal(confirm.countdownReason, "silence");

  const kept = reduce(confirm, { type: "keep_speaking", now: T0 + 9000 });
  assert.equal(kept.phase, PHASES.LISTENING, "tap to keep speaking returns to LISTENING");
  assert.equal(kept.countdownRemaining, 0);
  assert.equal(kept.countdownEndsAt, null);
  assert.equal(kept.speechDetected, true);

  const secondSilence = reduce(kept, { type: "tick", now: T0 + 9000 + SILENCE_MS });
  assert.equal(secondSilence.phase, PHASES.CONFIRM);

  const nearly = reduce(secondSilence, {
    type: "tick",
    now: T0 + 9000 + SILENCE_MS + COUNTDOWN_MS - 1000,
  });
  assert.equal(nearly.phase, PHASES.CONFIRM);
  assert.ok(nearly.countdownRemaining <= 1000);

  const submitted = reduce(secondSilence, {
    type: "tick",
    now: T0 + 9000 + SILENCE_MS + COUNTDOWN_MS,
  });
  assert.equal(submitted.phase, PHASES.SUBMITTING, "countdown expiry submits");
  assert.equal(submitted.countdownReason, "silence");
});

test("no speech for 20 seconds never auto-advances", () => {
  let state = listening();
  state = reduce(state, { type: "tick", now: T0 + NO_SPEECH_MS - 100 });
  assert.equal(state.wakePrompt, false);
  state = reduce(state, { type: "tick", now: T0 + NO_SPEECH_MS });
  assert.equal(state.phase, PHASES.LISTENING);
  assert.equal(state.wakePrompt, true);
  state = reduce(state, { type: "tick", now: T0 + NO_SPEECH_MS + 60000 });
  assert.equal(state.phase, PHASES.LISTENING, "still waiting after a minute without speech");
  assert.equal(reduce(state, { type: "still_here", now: T0 + 90000 }).wakePrompt, false);
});

test("Done submits immediately from LISTENING", () => {
  const state = reduce(listening(), { type: "done", now: T0 + 5000 });
  assert.equal(state.phase, PHASES.SUBMITTING);
  assert.equal(state.countdownReason, "manual");
});

test("three-minute hard cap warns at 2:30 and submits at 3:00", () => {
  let state = listening();
  state = reduce(state, { type: "tick", now: T0 + CAP_WARNING_MS });
  assert.equal(state.phase, PHASES.LISTENING);
  assert.equal(state.capWarning, true);
  state = reduce(state, { type: "tick", now: T0 + HARD_CAP_MS });
  assert.equal(state.phase, PHASES.SUBMITTING);
  assert.equal(state.countdownReason, "cap");
});

test("submission moves to a paused IDLE question and only the candidate starts ASKING", () => {
  let state = reduce(listening(), { type: "done", now: T0 + 2000 });
  state = reduce(state, {
    type: "submitted",
    finished: false,
    question: { ...QUESTION, turn_id: "turn-2", turn_no: 2, kind: "follow_up" },
    questionCount: 2,
    maxQuestions: 10,
    now: T0 + 3000,
  });
  assert.equal(state.phase, PHASES.IDLE, "paused between questions");
  assert.equal(state.question.turn_id, "turn-2");
  assert.equal(state.speechDetected, false);
  assert.equal(state.answerStartedAt, null);

  state = reduce(state, { type: "start_question", now: T0 + 10000 });
  assert.equal(state.phase, PHASES.ASKING);
  assert.equal(state.question.turn_id, "turn-2");

  const finished = reduce(
    reduce(listening(), { type: "done", now: T0 + 2000 }),
    { type: "submitted", finished: true, now: T0 + 3000 },
  );
  assert.equal(finished.phase, PHASES.FINISHED);
  assert.equal(finished.finished, true);
  assert.equal(finished.question, null);
});

test("submitted is ignored unless the machine is SUBMITTING", () => {
  const state = listening();
  const stray = reduce(state, { type: "submitted", finished: true, now: T0 });
  assert.strictEqual(stray, state);
});

test("deadline helpers use 1-3 day invitations and expire cleanly", () => {
  const now = Date.UTC(2026, 10, 28, 12, 0, 0);
  const threeDays = (now + 3 * 86400 * 1000) / 1000;
  assert.equal(Math.round(deadlineRemaining(threeDays, now) / 86400000), 3);
  assert.equal(formatRemaining(3 * 86400 * 1000), "3d 0h");
  assert.equal(formatRemaining(45 * 60 * 1000), "45m 0s");
  assert.equal(formatRemaining(0), "Expired");

  assert.equal(canStartInterview({ status: "invited", deadline_at: threeDays }, now), true);
  assert.equal(canStartInterview({ status: "submitted", deadline_at: threeDays }, now), false);
  assert.equal(canStartInterview({ status: "invited", deadline_at: now / 1000 - 1 }, now), false);
});
