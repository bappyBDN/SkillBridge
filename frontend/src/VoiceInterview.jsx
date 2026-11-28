import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import useBrowserRecognition from "./useBrowserRecognition.js";
import useCameraAnalysis from "./useCameraAnalysis.js";
import useCameraStream from "./useCameraStream.js";
import useInterviewMachine from "./useInterviewMachine.js";
import useProctor from "./useProctor.js";
import useRecorder from "./useRecorder.js";
import useSpeechSynthesis from "./useSpeechSynthesis.js";
import InterviewPrecheck from "./InterviewPrecheck.jsx";
import CandidateInterviewFlags from "./CandidateInterviewFlags.jsx";
import { mergeProctorRules } from "./proctorLogic.js";
import {
  CAP_WARNING_MS,
  HARD_CAP_MS,
  PHASES,
  deadlineRemaining,
  formatClock,
  formatRemaining,
} from "./interviewMachine.js";

const LANGUAGE_LABEL = { "bn-BD": "বাংলা", "en-US": "English" };
const SOURCE_LABEL = {
  opening: "Opening question",
  follow_up: "Follow-up",
  company_custom: "Company question",
};
const ACTIVE_PHASES = [
  PHASES.ASKING,
  PHASES.LISTENING,
  PHASES.CONFIRM,
  PHASES.SUBMITTING,
];

function inviteIdOf(invite) {
  return String(invite?.invite_id ?? invite?.id ?? "");
}

export default function VoiceInterview({ invite, onExit, onFinished }) {
  const inviteId = inviteIdOf(invite);
  const language = invite?.language || "en-US";
  const retentionDays = Number(invite?.retention_days || 90);
  const maxQuestions = Number(invite?.max_questions || 10);
  const initialLevel = invite?.proctoring_level || "standard";
  const finishedStatus = ["submitted", "in_review", "approved", "rejected",
    "redo_requested", "expired"].includes(String(invite?.status || ""));

  const [stage, setStage] = useState(
    initialLevel !== "off" && !finishedStatus
      ? "precheck"
      : invite?.consent_required ? "consent" : "loading",
  );
  const [proctorLevel, setProctorLevel] = useState(initialLevel);
  const [proctorMeta, setProctorMeta] = useState({
    consent_version: "ai-interview-proctoring-v1",
    shot_retention_days: invite?.shot_retention_days || 30,
  });
  const [rules, setRules] = useState(() => mergeProctorRules());
  const [baseline, setBaseline] = useState(null);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  const [questionShownAt, setQuestionShownAt] = useState(0);
  const camera = useCameraStream();
  const videoRef = useRef(null);
  const needsCamera = proctorLevel === "standard" || proctorLevel === "strict";
  const proctor = useProctor({
    inviteId,
    level: proctorLevel,
    enabled: stage === "interview",
    config: rules,
    currentTurn: 0,
    cameraStream: camera.stream,
    cameraLive: cameraUnavailable ? true : camera.live,
  });
  const machine = useInterviewMachine(proctor.blocked);
  const { state } = machine;
  const tts = useSpeechSynthesis();
  const recorder = useRecorder();
  const recognition = useBrowserRecognition({
    lang: language,
    active: state.phase === PHASES.LISTENING,
  });
  const analysis = useCameraAnalysis({
    videoRef,
    stream: camera.stream,
    enabled: needsCamera && camera.live && (stage === "precheck" || stage === "interview"),
    paused: proctor.blocked,
    config: rules,
    calibration: baseline,
    questionShownAt,
    turnNo: state.question?.turn_no || 0,
    onFlag: stage === "interview"
      ? (event) => proctor.report(event.type, event.detail, event.duration_ms, event.shot, event.turn_no)
      : undefined,
    onUnavailable: (reason) => {
      if (stage === "interview") {
        proctor.report("camera_analysis_unavailable", { reason }, 0);
      }
    },
  });

  const [consentChecked, setConsentChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const [audioMode, setAudioMode] = useState(invite?.audio_mode || "transcript_only");
  const [now, setNow] = useState(() => Date.now());
  const [ttsNotice, setTtsNotice] = useState("");

  const transcriptRef = useRef("");
  const startedRef = useRef(false);
  const submitLock = useRef(false);
  const audioConsentRef = useRef(!invite?.consent_required);
  const speakRef = useRef(tts.speak);
  const hasVoiceRef = useRef(tts.hasVoiceFor);
  speakRef.current = tts.speak;
  hasVoiceRef.current = tts.hasVoiceFor;

  const questionId = state.question?.turn_id || "";

  const startSession = useCallback(async () => {
    setStage("loading");
    setServerError("");
    try {
      const data = await api(`/interviews/${inviteId}/start`, { method: "POST" });
      if (data.proctor_precheck_required) {
        setStage("precheck");
        return;
      }
      if (data.calibration && Object.keys(data.calibration).length) {
        setBaseline(data.calibration);
      }
      if (data.finished) {
        setStage("done");
        return;
      }
      if (!data.question) {
        setServerError("The interview did not return a question. Please reload and try again.");
        setStage("error");
        return;
      }
      machine.loadQuestion(data.question, {
        questionCount: data.progress?.asked || data.question.turn_no,
        maxQuestions: data.progress?.max || maxQuestions,
      });
      setStage("interview");
    } catch (error) {
      if (error?.code === "consent_required") {
        setServerError("Please confirm the privacy notice before you begin.");
        setStage("consent");
        return;
      }
      setServerError(error?.message || "The interview could not start.");
      setStage("error");
    }
  }, [inviteId, machine, maxQuestions]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (initialLevel !== "off" && !finishedStatus) {
      setStage("precheck");
      return;
    }
    if (invite?.consent_required && !finishedStatus) setStage("consent");
    else startSession();
    // Started once for this invite; resuming is handled by the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the live proctoring config (the server owns the thresholds).
  useEffect(() => {
    if (stage !== "precheck") return undefined;
    let cancelled = false;
    api(`/interviews/${inviteId}/proctor/config`)
      .then((data) => {
        if (cancelled) return;
        setProctorLevel(data.proctoring_level || initialLevel);
        setRules(mergeProctorRules(data.rules));
        setProctorMeta(data);
      })
      .catch(() => { /* defaults keep the pre-check usable */ });
    return () => { cancelled = true; };
  }, [stage, inviteId, initialLevel]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handler = (event) => {
      if (!ACTIVE_PHASES.includes(state.phase)) return undefined;
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state.phase]);

  // Reset the live preview for each new question and clear the speech buffer.
  useEffect(() => {
    transcriptRef.current = "";
    recognition.reset();
    setTtsNotice("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  // The AI reads the question once, only in ASKING (microphone off). While a
  // proctor overlay covers the UI it stays silent and does not start/advance.
  useEffect(() => {
    if (proctor.blocked) return undefined;
    if (state.phase !== PHASES.ASKING || !state.question) return undefined;
    let cancelled = false;
    const text = state.question.text || "";
    if (!tts.supported || !hasVoiceRef.current(language)) {
      setTtsNotice(
        tts.supported
          ? `No ${LANGUAGE_LABEL[language] || language} voice is installed on this device. The question is shown as text and listening works normally.`
          : "This browser cannot read questions aloud. The question is shown as text and listening works normally.",
      );
      machine.ttsUnavailable();
      return undefined;
    }
    speakRef.current(text, language).then((result) => {
      if (cancelled) return;
      if (result.spoken) {
        machine.finishReading();
      } else if (result.reason === "no_voice" || result.reason === "unsupported") {
        setTtsNotice(
          `No ${LANGUAGE_LABEL[language] || language} voice is installed on this device. The question is shown as text and listening works normally.`,
        );
        machine.ttsUnavailable();
      } else {
        // Blocked or timed out: stay in ASKING so the AI never speaks over the
        // candidate. The Skip reading button is always available.
        setTtsNotice("Question audio could not play. Tap “Skip reading” to answer.");
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, questionId, language, tts.supported, proctor.blocked]);

  // Pause/resume TTS for the overlay without cancelling the utterance (only the
  // candidate's Skip button may cancel).
  useEffect(() => {
    if (proctor.blocked) tts.pause();
    else tts.resume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proctor.blocked]);

  // Timestamp for the gaze reading-suppression window.
  useEffect(() => {
    if (state.phase === PHASES.ASKING && questionId) setQuestionShownAt(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, state.phase === PHASES.ASKING]);

  // Microphone and recorder are live only while the candidate is answering.
  useEffect(() => {
    if (state.phase === PHASES.LISTENING) recorder.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // Analyser level counts as detected speech (after the mic starts).
  useEffect(() => {
    if (state.phase !== PHASES.LISTENING) return;
    if (recorder.level > recorder.speechLevel) machine.markSpeech();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.level, state.phase]);

  // Browser preview text is the fallback transcript.
  useEffect(() => {
    transcriptRef.current = recognition.transcript || "";
    if (recognition.transcript && state.phase === PHASES.LISTENING) machine.markSpeech();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recognition.transcript, state.phase]);

  // One place performs the network submission, after the recorder flushes.
  useEffect(() => {
    if (state.phase !== PHASES.SUBMITTING || submitLock.current) return;
    submitLock.current = true;
    let cancelled = false;
    (async () => {
      const blob = await recorder.stop();
      const started = Number(state.answerStartedAt || Date.now());
      const answeredAt = Date.now();
      const form = new FormData();
      form.append("turn_id", state.question?.turn_id || "");
      form.append("browser_transcript", transcriptRef.current || "");
      form.append("transcript_source", "browser");
      form.append("answer_started_at", String(started / 1000));
      form.append("answered_at", String(answeredAt / 1000));
      form.append("audio_ms", String(Math.max(0, Math.min(answeredAt - started, HARD_CAP_MS))));
      form.append("speech_detected", state.speechDetected ? "true" : "false");
      if (blob && blob.size > 0) form.append("audio", blob, "answer.webm");
      try {
        const data = await api(`/interviews/${inviteId}/answer`, { method: "POST", form });
        if (cancelled) return;
        onFinished?.();
        machine.submitted({
          finished: Boolean(data.finished),
          question: data.question || null,
          questionCount: data.question?.turn_no,
          maxQuestions: data.progress?.max,
          submittedAt: answeredAt / 1000,
        });
      } catch (error) {
        if (cancelled) return;
        machine.submitFailed(error?.message || "Could not save this answer.");
      } finally {
        submitLock.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  useEffect(() => {
    if (state.phase === PHASES.ERROR && state.error) setServerError("");
  }, [state.phase, state.error]);

  const completePrecheck = useCallback(async ({ baseline: base, baselineShot, cameraUnavailable: camOff }) => {
    setBusy(true);
    setServerError("");
    try {
      if (!audioConsentRef.current) {
        await api(`/interviews/${inviteId}/consent`, { method: "POST", body: { language } });
        audioConsentRef.current = true;
      }
      const form = new FormData();
      form.append("consent_version", proctorMeta.consent_version || "ai-interview-proctoring-v1");
      form.append("calibration", JSON.stringify(base || {}));
      form.append("camera_analysis_unavailable", camOff ? "true" : "false");
      if (baselineShot) form.append("baseline", baselineShot, "baseline.jpg");
      const result = await api(`/interviews/${inviteId}/precheck`, { method: "POST", form });
      setBaseline(base || {});
      setCameraUnavailable(Boolean(camOff));
      if (result.audio_mode) setAudioMode(result.audio_mode);
      await startSession();
    } catch (error) {
      setServerError(error?.message || "The pre-check could not be saved.");
      setStage("precheck");
    } finally {
      setBusy(false);
    }
  }, [inviteId, language, proctorMeta.consent_version, startSession]);

  const acceptConsent = async () => {
    if (!consentChecked || busy) return;
    setBusy(true);
    setServerError("");
    try {
      const result = await api(`/interviews/${inviteId}/consent`, {
        method: "POST",
        body: { language },
      });
      if (result.audio_mode) setAudioMode(result.audio_mode);
      audioConsentRef.current = true;
      startedRef.current = true;
      if (proctorLevel !== "off") setStage("precheck");
      else await startSession();
    } catch (error) {
      setServerError(error?.message || "Could not save your consent.");
    } finally {
      setBusy(false);
    }
  };

  const skipReading = () => {
    tts.cancel();
    machine.skipReading();
  };

  const exit = () => {
    onExit?.();
  };

  const remaining = deadlineRemaining(invite?.deadline_at, now);
  const elapsed = state.answerStartedAt ? Math.max(0, now - state.answerStartedAt) : 0;
  const warning = state.capWarning || elapsed >= CAP_WARNING_MS;
  const questionNo = state.question?.turn_no || state.questionCount || 0;
  const maxNo = state.maxQuestions || maxQuestions;

  const phaseLabel = useMemo(() => {
    switch (state.phase) {
      case PHASES.ASKING:
        return "Reading the question";
      case PHASES.LISTENING:
        return "Listening — the AI is silent";
      case PHASES.CONFIRM:
        return "Submitting after silence";
      case PHASES.SUBMITTING:
        return "Saving your answer";
      case PHASES.ERROR:
        return "Answer not saved";
      case PHASES.FINISHED:
        return "Interview complete";
      case PHASES.IDLE:
        return state.question ? "Ready for the next question" : "Paused";
      default:
        return "Interview";
    }
  }, [state.phase, state.question]);

  return (
    <div className="vi-overlay" role="dialog" aria-modal="true" aria-labelledby="vi-title">
      <div className="vi-shell">
        <header className="vi-head">
          <div>
            <span className="eyebrow">Voice AI interview</span>
            <h1 id="vi-title">{invite?.job_title || "Interview"}</h1>
            <p>
              {invite?.company_name || "Company"} · {LANGUAGE_LABEL[language] || language} ·{" "}
              <span className={remaining > 0 ? "vi-deadline" : "vi-deadline expired"}>
                {remaining > 0 ? `${formatRemaining(remaining)} left` : "Deadline passed"}
              </span>
            </p>
          </div>
          {stage === "interview" && state.phase === PHASES.IDLE && (
            <button type="button" className="btn ghost sm" onClick={exit}>
              Pause &amp; exit
            </button>
          )}
          {(stage === "done" || stage === "error" || stage === "consent" || stage === "precheck") && (
            <button type="button" className="btn ghost sm" onClick={exit}>
              Close
            </button>
          )}
        </header>

        {stage === "precheck" && (
          <InterviewPrecheck
            invite={invite}
            config={{ ...proctorMeta, proctoring_level: proctorLevel, rules }}
            proctor={proctor}
            camera={camera}
            videoRef={videoRef}
            analysis={analysis}
            busy={busy}
            onComplete={completePrecheck}
            onCancel={exit}
          />
        )}

        {stage === "consent" && (
          <section className="vi-panel vi-consent" aria-labelledby="vi-consent-title">
            <h2 id="vi-consent-title">Before you begin</h2>
            <ul>
              <li>
                Your spoken answers are <strong>recorded</strong> and transcribed for{" "}
                <strong>human review</strong>. Audio is stored in private object storage and is
                never kept in the application database.
              </li>
              <li>
                In Chrome or Edge the live transcript preview may send audio to the browser
                vendor. In Safari or Firefox the preview is unavailable; recording and
                server-side transcription still work.
              </li>
              <li>
                The AI only asks questions. It never scores, judges or fails you. A person
                reviews the interview before any company sees it.
              </li>
              <li>
                You can pause between questions and resume until the deadline. A question
                that was interrupted is asked again.
              </li>
              <li>
                Recordings are kept for <strong>{retentionDays} days</strong> unless you ask
                for deletion.
              </li>
            </ul>
            <label className="vi-check">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(event) => setConsentChecked(event.target.checked)}
              />
              <span>
                I understand my answers are recorded and reviewed by a person, and I consent
                to this interview.
              </span>
            </label>
            {!recognition.supported && (
              <p className="vi-note" role="status">
                Live transcript preview is unavailable in this browser (Safari/Firefox).
                Recording and server-side transcription still work.
              </p>
            )}
            {serverError && (
              <p className="vi-error" role="alert">
                {serverError}
              </p>
            )}
            <div className="vi-actions">
              <button
                type="button"
                className="btn"
                disabled={!consentChecked || busy}
                onClick={acceptConsent}
              >
                {busy ? "Saving…" : "I consent and continue"}
              </button>
              <button type="button" className="btn ghost" onClick={exit} disabled={busy}>
                Not now
              </button>
            </div>
          </section>
        )}

        {stage === "loading" && (
          <section className="vi-panel vi-center" aria-live="polite">
            <div className="vi-spinner" aria-hidden="true" />
            <p>Preparing your interview…</p>
          </section>
        )}

        {stage === "error" && (
          <section className="vi-panel vi-center" role="alert">
            <h2>The interview could not start</h2>
            <p>{serverError || "Please check your connection and try again."}</p>
            <div className="vi-actions">
              <button type="button" className="btn" onClick={startSession}>
                Try again
              </button>
              <button type="button" className="btn ghost" onClick={exit}>
                Close
              </button>
            </div>
          </section>
        )}

        {stage === "done" && (
          <section className="vi-panel vi-center" aria-live="polite">
            <div className="vi-done-mark" aria-hidden="true">
              ✓
            </div>
            <h2>Interview complete</h2>
            <p>
              Your answers are saved and now wait for a human review. No score is produced by
              the AI. You can close this window.
            </p>
            <div className="vi-actions">
              <button type="button" className="btn" onClick={exit}>
                Back to my workspace
              </button>
            </div>
            <CandidateInterviewFlags inviteId={inviteId} />
          </section>
        )}

        {stage === "interview" && (
          <>
            {needsCamera && !cameraUnavailable && (
              <video ref={videoRef} autoPlay muted playsInline className="vi-analysis-video" />
            )}
            {proctor.blocked && proctor.overlay && (
              <div className="vi-proctor-overlay" role="alertdialog" aria-modal="true"
                   aria-labelledby="vi-proctor-title">
                <div className="vi-proctor-card">
                  <span className="vi-proctor-icon" aria-hidden="true">!</span>
                  <h2 id="vi-proctor-title">{proctor.overlay.title}</h2>
                  <p>{proctor.notice || "The interview view is paused. The AI stays silent; recording and the answer timer continue."}</p>
                  <div className="vi-actions vi-center-row">
                    {proctor.overlay.reason === "fullscreen_exit" && (
                      <button type="button" className="btn" onClick={() => proctor.enterFullscreen()}>
                        Return to full screen
                      </button>
                    )}
                    {proctor.overlay.reason === "camera_lost" && (
                      <button type="button" className="btn" onClick={() => camera.start()}>
                        Restore camera
                      </button>
                    )}
                    {proctor.overlay.reason === "screen_share_stopped" && (
                      <button type="button" className="btn" onClick={() => proctor.startScreenShare()}>
                        Share entire screen again
                      </button>
                    )}
                    {proctor.overlay.reason === "second_tab" && (
                      <button type="button" className="btn" onClick={proctor.claimTab}>
                        Use this tab
                      </button>
                    )}
                  </div>
                  <p className="cr-footnote">
                    This is an advisory event for human review. It does not fail you or change your answers.
                  </p>
                </div>
              </div>
            )}
            <div className="vi-progress" aria-label={`Question ${questionNo} of ${maxNo}`}>
              <div className="vi-progress-bar">
                <span style={{ width: `${Math.min(100, (questionNo / Math.max(1, maxNo)) * 100)}%` }} />
              </div>
              <span>
                Question {questionNo} of {maxNo}
              </span>
            </div>

            <p className="vi-phase" aria-live="polite">
              {phaseLabel}
            </p>

            {remaining <= 0 && (
              <p className="vi-error" role="alert">
                The deadline has passed. Answers you already submitted are kept; unfinished
                questions can no longer be answered.
              </p>
            )}

            {state.question && (
              <article className="vi-question-card">
                <span className="vi-source">
                  {SOURCE_LABEL[state.question.kind] || "Question"}
                </span>
                <p className="vi-question">{state.question.text}</p>
              </article>
            )}

            {ttsNotice && (
              <p className="vi-note" role="status">
                {ttsNotice}
              </p>
            )}

            {state.phase === PHASES.ASKING && (
              <div className="vi-actions vi-center-row">
                <button type="button" className="btn ghost" onClick={skipReading}>
                  Skip reading
                </button>
              </div>
            )}

            {(state.phase === PHASES.LISTENING || state.phase === PHASES.CONFIRM) && (
              <section className="vi-answer" aria-label="Your answer">
                <div className="vi-mic-row">
                  <span
                    className={
                      "vi-mic " +
                      (state.phase === PHASES.LISTENING ? "on" : "warn")
                    }
                    aria-hidden="true"
                  >
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="2" width="6" height="12" rx="3" />
                      <path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
                    </svg>
                  </span>
                  <div className="vi-wave" aria-hidden="true">
                    {Array.from({ length: 16 }).map((_, index) => {
                      const shape = 0.25 + Math.abs(Math.sin((index + 1) * 1.7)) * 0.75;
                      const value = Math.max(0.12, Math.min(1, recorder.level * 9 * shape));
                      return <span key={index} style={{ transform: `scaleY(${value})` }} />;
                    })}
                  </div>
                  <span className={"vi-timer" + (warning ? " warn" : "")}>
                    {formatClock(elapsed)}
                  </span>
                </div>
                <p className="vi-live-transcript" aria-live="polite">
                  {recognition.transcript || (recorder.active ? "Speak now…" : "Starting your microphone…")}
                </p>
                {!recognition.supported && (
                  <p className="vi-note">
                    Live transcript preview is unavailable in this browser. Your answer is
                    still recorded and transcribed after you submit.
                  </p>
                )}
                {recorder.error && (
                  <div className="vi-error" role="alert">
                    <span>{recorder.error}</span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => recorder.start()}
                    >
                      Try microphone again
                    </button>
                  </div>
                )}
                {state.wakePrompt && (
                  <div className="vi-wake" role="status">
                    <strong>Still there?</strong>
                    <span>No speech detected yet. Take your time — nothing is submitted automatically.</span>
                    <button type="button" className="btn ghost sm" onClick={machine.stillHere}>
                      I&apos;m here
                    </button>
                  </div>
                )}
                {warning && elapsed < HARD_CAP_MS && (
                  <p className="vi-warning" role="status">
                    Thirty seconds left. Your answer is submitted at three minutes.
                  </p>
                )}
                {state.phase === PHASES.LISTENING ? (
                  <div className="vi-actions vi-center-row">
                    <button type="button" className="btn" onClick={machine.submitNow}>
                      Done / Submit answer
                    </button>
                  </div>
                ) : (
                  <div className="vi-confirm" role="status">
                    <p>
                      Submitting in{" "}
                      <strong>{Math.ceil(state.countdownRemaining / 1000)}s</strong>…
                    </p>
                    <button type="button" className="btn" onClick={machine.keepSpeaking}>
                      Tap to keep speaking
                    </button>
                  </div>
                )}
              </section>
            )}

            {state.phase === PHASES.SUBMITTING && (
              <section className="vi-panel vi-center" aria-live="polite">
                <div className="vi-spinner" aria-hidden="true" />
                <p>Saving your answer…</p>
              </section>
            )}

            {state.phase === PHASES.IDLE && state.question && (
              <section className="vi-paused" aria-live="polite">
                <p>{state.notice || "You can pause here. The deadline still applies."}</p>
                <div className="vi-actions vi-center-row">
                  <button type="button" className="btn" onClick={machine.startQuestion}>
                    Start question
                  </button>
                  <button type="button" className="btn ghost" onClick={exit}>
                    Pause &amp; come back later
                  </button>
                </div>
              </section>
            )}

            {state.phase === PHASES.ERROR && (
              <section className="vi-panel vi-center" role="alert">
                <h2>Your answer was not saved</h2>
                <p>{state.error || "Check your connection and try again."}</p>
                <div className="vi-actions">
                  <button type="button" className="btn" onClick={machine.retry}>
                    Retry saving
                  </button>
                  <button type="button" className="btn ghost" onClick={exit}>
                    Close
                  </button>
                </div>
              </section>
            )}

            {state.phase === PHASES.FINISHED && (
              <section className="vi-panel vi-center" aria-live="polite">
                <div className="vi-done-mark" aria-hidden="true">
                  ✓
                </div>
                <h2>All questions answered</h2>
                <p>
                  Your interview is submitted for human review. The AI did not score or judge
                  your answers.
                </p>
                <div className="vi-actions">
                  <button type="button" className="btn" onClick={exit}>
                    Back to my workspace
                  </button>
                </div>
                <CandidateInterviewFlags inviteId={inviteId} />
              </section>
            )}

            <footer className="vi-foot">
              <span>
                {audioMode === "stored"
                  ? "Audio is recorded and stored privately."
                  : "Transcript-only mode: audio storage is not configured on this deployment."}
              </span>
              <span>Retention: {retentionDays} days</span>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
