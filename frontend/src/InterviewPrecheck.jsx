import { useMemo, useState } from "react";
import { api } from "./api.js";
import { captureFrame } from "./useCameraAnalysis.js";

const LANGUAGE_LABEL = { "bn-BD": "বাংলা", "en-US": "English" };

function desktopBrowser() {
  if (typeof navigator === "undefined") return false;
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}

/**
 * Pre-check before the first question (and again on resume):
 * browser support, camera/mic, live face feedback, 5 s calibration, baseline
 * photo, fullscreen test and the interview-proctoring consent.
 */
export default function InterviewPrecheck({
  invite,
  config,
  proctor,
  camera,
  videoRef,
  analysis,
  onComplete,
  onCancel,
  busy = false,
}) {
  const level = config?.proctoring_level || "standard";
  const needsCamera = level === "standard" || level === "strict";
  const needsFullscreen = needsCamera;
  const needsShare = level === "strict";
  const retentionDays = Number(invite?.retention_days || 90);
  const shotRetention = Number(config?.shot_retention_days || 30);

  const [consent, setConsent] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [baseline, setBaseline] = useState(null);
  const [baselineShot, setBaselineShot] = useState(null);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  const [fullscreenTested, setFullscreenTested] = useState(
    typeof document !== "undefined" && Boolean(document.fullscreenElement),
  );
  const [micStatus, setMicStatus] = useState("");
  const [error, setError] = useState("");
  const [accommodationNote, setAccommodationNote] = useState("");
  const [accommodationNotice, setAccommodationNotice] = useState("");
  const [accommodationBusy, setAccommodationBusy] = useState(false);

  const metrics = analysis?.metrics;
  const faceDetected = (metrics?.face_count || 0) >= 1;
  const lighting = metrics?.lighting || "unknown";
  const supported = Boolean(
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia &&
    (typeof document === "undefined" || document.documentElement.requestFullscreen),
  );

  const startDisabled = useMemo(() => {
    if (!consent || busy) return true;
    if (!supported) return true;
    if (needsCamera && !cameraUnavailable && !baseline) return true;
    if (needsShare && !proctor?.shareActive) return true;
    return false;
  }, [consent, busy, supported, needsCamera, cameraUnavailable, baseline, needsShare, proctor?.shareActive]);

  const testMic = async () => {
    setMicStatus("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      setMicStatus("Microphone works.");
    } catch {
      setMicStatus("Microphone access was denied. You can still read the privacy notice and ask for help.");
    }
  };

  const calibrate = async () => {
    setError("");
    if (!faceDetected) {
      setError("Keep your face in the preview and look at the middle of the screen.");
      return;
    }
    setCalibrating(true);
    setCountdown(5);
    const baselineResult = await analysis.sampleBaseline(5000);
    setCalibrating(false);
    setCountdown(0);
    if (!baselineResult) {
      setError("No face was detected during calibration. Check lighting and try again.");
      return;
    }
    const shot = await captureFrame(videoRef.current);
    if (!shot) {
      setError("The baseline photo could not be captured. Try again or continue without a camera.");
      return;
    }
    setBaseline(baselineResult);
    setBaselineShot(shot);
  };

  const enterFullscreen = async () => {
    const ok = await proctor?.enterFullscreen?.();
    setFullscreenTested(ok || Boolean(document.fullscreenElement));
  };

  const requestAccommodation = async () => {
    if (accommodationNote.trim().length < 3) {
      setError("Describe the accommodation you need in a short sentence.");
      return;
    }
    setAccommodationBusy(true);
    setError("");
    try {
      await api(`/interviews/${invite?.invite_id || invite?.id}/proctor/accommodation-request`, {
        method: "POST",
        body: {
          note: accommodationNote.trim(),
          gaze_enabled: false,
          prefer_manual: true,
        },
      });
      setAccommodationNotice("Request sent to a platform reviewer. You can close this and wait.");
      setAccommodationNote("");
    } catch (e) {
      setError(e?.message || "The accommodation request could not be sent.");
    } finally {
      setAccommodationBusy(false);
    }
  };

  const start = async () => {
    if (startDisabled) return;
    // Fullscreen must be requested inside this user gesture.
    if (needsFullscreen && !document.fullscreenElement) {
      await proctor?.enterFullscreen?.();
    }
    onComplete?.({
      baseline: baseline || {},
      baselineShot,
      cameraUnavailable: needsCamera && (!camera.live || cameraUnavailable),
    });
  };

  return (
    <div className="vi-precheck">
      <header className="vi-precheck-head">
        <div>
          <span className="eyebrow">Before the first question</span>
          <h2>Check your setup</h2>
          <p>
            {invite?.job_title || "Interview"} · {LANGUAGE_LABEL[invite?.language] || "English"} ·{" "}
            {String(level).replaceAll("_", " ")} proctoring
          </p>
        </div>
        <button type="button" className="btn ghost sm" onClick={onCancel}>Close</button>
      </header>

      {!desktopBrowser() && level !== "light" && level !== "off" && (
        <p className="vi-note" role="status">
          Phones and tablets are not supported for standard or strict proctoring. Use a desktop
          Chrome, Edge or Firefox, or ask the company for a manual/Zoom interview.
        </p>
      )}

      <section className="vi-precheck-grid">
        <div className="vi-precheck-camera">
          <video ref={videoRef} autoPlay muted playsInline className="vi-preview" />
          {!camera.live && (
            <div className="vi-preview-empty">
              <p>
                {needsCamera
                  ? "Camera is off. Enable it for face detection during the interview."
                  : "Camera is not required at this proctoring level."}
              </p>
              {needsCamera && (
                <button type="button" className="btn sm" onClick={() => camera.start()} disabled={camera.busy}>
                  {camera.busy ? "Starting…" : "Enable camera"}
                </button>
              )}
            </div>
          )}
          {camera.live && (
            <div className="vi-preview-status">
              <span className={faceDetected ? "ok" : "warn"}>
                {faceDetected ? "Face detected" : "No face detected"}
              </span>
              <span className={lighting === "good" ? "ok" : "warn"}>
                {lighting === "good" ? "Lighting looks good" : lighting === "low" ? "Too dark" : lighting === "bright" ? "Too bright" : "Checking light"}
              </span>
            </div>
          )}
          {camera.error && <p className="vi-error" role="alert">{camera.error}</p>}
          {needsCamera && !cameraUnavailable && (
            <button
              type="button"
              className="cr-text-btn"
              onClick={() => {
                camera.stop();
                setCameraUnavailable(true);
                setBaseline(null);
              }}
            >
              Continue without camera (browser-event proctoring only)
            </button>
          )}
          {cameraUnavailable && (
            <p className="vi-note" role="status">
              Camera analysis is off. The interview continues with browser-event proctoring only.
            </p>
          )}
          {analysis?.unavailable && !cameraUnavailable && (
            <p className="vi-note" role="status">
              Face analysis could not start on this device. Use “Continue without camera” to finish
              with browser-event proctoring; the interview is never blocked because the model failed.
            </p>
          )}
        </div>

        <div className="vi-precheck-steps">
          <div className="vi-check-step">
            <h3>1 · Camera and microphone</h3>
            <p>Audio is recorded for review and transcribed. The camera is analysed on this device; no video is recorded.</p>
            <div className="vi-actions">
              {needsCamera && (
                <button type="button" className="btn ghost sm" onClick={() => camera.start()} disabled={camera.live}>
                  {camera.live ? "Camera ready" : "Enable camera"}
                </button>
              )}
              <button type="button" className="btn ghost sm" onClick={testMic}>Test microphone</button>
            </div>
            {micStatus && <p className="vi-note">{micStatus}</p>}
          </div>

          <div className="vi-check-step">
            <h3>2 · Five-second calibration</h3>
            <p>Look at the middle of your screen and stay still. We store your neutral head pose and gaze for this session.</p>
            <div className="vi-actions">
              <button
                type="button"
                className="btn ghost sm"
                onClick={calibrate}
                disabled={!camera.live || calibrating || !faceDetected || analysis?.loading || !analysis}
              >
                {calibrating ? `Calibrating… ${countdown}s` : baseline ? "Recalibrate" : "Start calibration"}
              </button>
              {baseline && <span className="vi-done-chip">Neutral pose saved</span>}
            </div>
          </div>

          {needsFullscreen && (
            <div className="vi-check-step">
              <h3>3 · Full screen</h3>
              <p>Leaving full screen pauses the interview view. The AI stays silent and your answer keeps recording.</p>
              <div className="vi-actions">
                <button type="button" className="btn ghost sm" onClick={enterFullscreen}>
                  {fullscreenTested || proctor?.fullscreenActive ? "Full screen ready" : "Test full screen"}
                </button>
              </div>
            </div>
          )}

          {needsShare && (
            <div className="vi-check-step">
              <h3>4 · Share your entire screen</h3>
              <p>Choose “Entire screen” in the browser picker. This is required at the strict level.</p>
              <div className="vi-actions">
                <button type="button" className="btn ghost sm" onClick={() => proctor?.startScreenShare?.()}>
                  {proctor?.shareActive ? "Screen shared" : "Share screen"}
                </button>
              </div>
              {proctor?.shareError && <p className="vi-error">{proctor.shareError}</p>}
            </div>
          )}
        </div>
      </section>

      <section className="vi-consent-compact">
        <h3>Consent</h3>
        <ul>
          <li>Audio is recorded and transcribed for human review.</li>
          <li>The camera is analysed on this device only. No continuous video is recorded or uploaded.</li>
          <li>One baseline photo is saved for the platform reviewer. Snapshots are saved only when a flag fires; the company never sees images.</li>
          <li>Flags are advisory. They never change your answers, fail you or stop the interview permanently. A person reviews every flag, and you can appeal after submission.</li>
          <li>Interview audio/transcripts are kept for {retentionDays} days; snapshots for {shotRetention} days, unless held for an active review or appeal.</li>
          <li>You may ask for deletion or for a manual/Zoom alternative instead of AI proctoring.</li>
        </ul>
        <label className="vi-check">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          <span>
            I understand and consent to camera analysis on this device, audio recording, and human
            review of advisory flags.
          </span>
        </label>
        <div className="vi-accommodation">
          <strong>Need an accommodation?</strong>
          <p className="cr-footnote">
            Ask a platform reviewer to disable gaze analysis or offer a manual/Zoom interview.
            The company is told only that a request was made.
          </p>
          <textarea
            rows="2"
            maxLength={1000}
            value={accommodationNote}
            placeholder="For example: please disable gaze analysis or use a manual interview."
            onChange={(event) => setAccommodationNote(event.target.value)}
          />
          <button type="button" className="btn ghost sm" disabled={accommodationBusy}
                  onClick={requestAccommodation}>
            {accommodationBusy ? "Sending…" : "Send accommodation request"}
          </button>
          {accommodationNotice && <p className="success-note" role="status">{accommodationNotice}</p>}
        </div>
        {error && <p className="vi-error" role="alert">{error}</p>}
        <div className="vi-actions">
          <button type="button" className="btn" onClick={start} disabled={startDisabled}>
            {busy ? "Preparing…" : "Start interview"}
          </button>
          <button type="button" className="btn ghost" onClick={onCancel}>Not now</button>
        </div>
        {needsCamera && !cameraUnavailable && !baseline && (
          <p className="cr-footnote">Calibration is required unless you continue without a camera.</p>
        )}
        {needsShare && !proctor?.shareActive && (
          <p className="cr-footnote">Share your entire screen before starting at the strict level.</p>
        )}
      </section>
    </div>
  );
}
