import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASES,
  SILENCE_MS,
  reduce,
} from "../src/interviewMachine.js";
import {
  analysisDelayMs,
  isGazeSuppressed,
  proctorOverlay,
} from "../src/proctorLogic.js";

const T0 = 2_000_000;
const QUESTION = {
  turn_id: "turn-1",
  turn_no: 1,
  text: "Tell me about your most recent project.",
  kind: "opening",
};

function listening() {
  let state = reduce(
    { ...requireState(), phase: PHASES.IDLE },
    { type: "question_loaded", question: QUESTION, now: T0 },
  );
  state = reduce(state, { type: "tts_end", now: T0 });
  return reduce(state, { type: "speech_detected", now: T0 + 1000 });
}

// Small local initial state builder that mirrors initialInterviewState without
// importing React-adjacent code.
function requireState() {
  return {
    phase: PHASES.IDLE,
    question: null,
    questionCount: 0,
    maxQuestions: 10,
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

test("fullscreen/camera overlay freezes silence and the AI cannot advance", () => {
  let state = listening();
  const afterSilence = reduce(state, {
    type: "tick",
    now: T0 + 1000 + SILENCE_MS,
    blocked: true,
  });
  assert.equal(afterSilence.phase, PHASES.LISTENING,
    "blocked overlay must not enter CONFIRM or SUBMITTING");
  assert.strictEqual(afterSilence, state, "a blocked tick must not mutate the answer state");

  // The microphone/recorder phase is unchanged, so recording continues.
  assert.equal(state.phase, PHASES.LISTENING);

  // After returning, the silence clock restarts and only then can advance.
  const resumed = reduce(afterSilence, { type: "resume", now: T0 + 9000 });
  assert.equal(resumed.phase, PHASES.LISTENING);
  const confirm = reduce(resumed, { type: "tick", now: T0 + 9000 + SILENCE_MS });
  assert.equal(confirm.phase, PHASES.CONFIRM);
});

test("a blocked confirm countdown does not auto-submit", () => {
  let state = listening();
  state = reduce(state, { type: "tick", now: T0 + 1000 + SILENCE_MS });
  assert.equal(state.phase, PHASES.CONFIRM);
  const frozen = reduce(state, {
    type: "tick",
    now: T0 + 1000 + SILENCE_MS + 9000,
    blocked: true,
  });
  assert.strictEqual(frozen, state);
  const resumed = reduce(frozen, { type: "resume", now: T0 + 12000 });
  assert.equal(resumed.phase, PHASES.CONFIRM);
  const submitted = reduce(resumed, {
    type: "tick",
    now: T0 + 12000 + resumed.countdownRemaining,
  });
  assert.equal(submitted.phase, PHASES.SUBMITTING);
});

test("gaze is suppressed for the reading window only", () => {
  const shown = 50_000;
  assert.equal(isGazeSuppressed(shown, shown + 2999, 3000), true);
  assert.equal(isGazeSuppressed(shown, shown + 3000, 3000), false);
  assert.equal(isGazeSuppressed(0, shown, 3000), false);
});

test("analysis throttling pauses in a hidden tab and slows down expensive frames", () => {
  assert.equal(analysisDelayMs(10, true), 1000);
  assert.equal(analysisDelayMs(10, false), 400);
  assert.equal(analysisDelayMs(180, false), 650);
  assert.equal(analysisDelayMs(400, false), 900);
});

test("proctor overlay appears for fullscreen exit, camera loss, strict share and second tab", () => {
  assert.equal(proctorOverlay({ level: "light", fullscreenActive: false, cameraLive: false }), null);
  const fs = proctorOverlay({ level: "standard", fullscreenActive: false, cameraLive: true });
  assert.equal(fs.reason, "fullscreen_exit");
  const cam = proctorOverlay({ level: "standard", fullscreenActive: true, cameraLive: false });
  assert.equal(cam.reason, "camera_lost");
  const share = proctorOverlay({
    level: "strict", fullscreenActive: true, cameraLive: true, shareLive: false,
  });
  assert.equal(share.reason, "screen_share_stopped");
  const tab = proctorOverlay({
    level: "standard", fullscreenActive: true, cameraLive: true, secondTab: true,
  });
  assert.equal(tab.reason, "second_tab");
  assert.equal(proctorOverlay({
    level: "strict", fullscreenActive: true, cameraLive: true, shareLive: true,
  }), null);
});
