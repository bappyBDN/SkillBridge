# R1 proctored-exam mode (separate from camera-free R0)

This feature is **not enabled in R0**. A deployment explicitly selects R1:

```dotenv
ASSESSMENT_PROCTORING_MODE=r1
EVIDENCE_RETENTION_DAYS=30
```

Restart the backend (or recreate its Docker Compose service) after changing the environment. Compose already reads `.env`; direct Uvicorn deployments must set these environment variables in their service configuration. No AI provider key is required: camera models run on the candidate's device. Set `ASSESSMENT_PROCTORING_MODE=r0` to keep new attempts camera-free. Existing attempts retain their own policy snapshot.

## Mandatory setup

1. Read the dedicated R1 notice and explicitly accept `r1-proctoring-v1` consent. Camera/microphone controls are disabled before consent.
2. Share **Entire screen**, not a window or browser tab. The browser's native sharing picker and explicit approval cannot be bypassed.
3. Enable camera and verify that live video frames can actually be decoded, not merely that a permission was granted.
4. Enable microphone. Resume the AudioContext from that user click and check that local level analysis is available. Audio is **not** recorded, transcribed or uploaded.
5. Enter full-screen using its separate user-click button.
6. Run local comparison with the profile photo. A mismatch, missing reference, disability/accessibility issue or unavailable model may be explicitly referred to human identity review; there is no automatic impersonation verdict or rejection. Biometric descriptors exist only temporarily in browser memory and are not stored.

All four media/browser conditions are required to start and continue. Missing camera/microphone, hidden tab, lost screen share or exited full-screen pauses the answer controls; the server deadline continues. Restore the missing permission or **Quit assessment**. Quitting does not require working media access. The Initial exam remains 40 questions / 40 minutes; Profile retakes retain their existing durations and review/credit gates.

## What is monitored

- MediaPipe face landmarks: sustained missing face or multiple faces. No emotion, attention/personality, demographic or identity inference is made by the live monitor.
- MediaPipe object detection: a possible phone. Model failures are shown as technical monitoring gaps, not silently reported as successful monitoring.
- Web Audio RMS level: a sustained level above `0.028` for at least one second. Signals are throttled to one per 15 seconds. This is **not speech recognition**, speaker identification or a determination that someone is helping the candidate. Thresholds are device/environment dependent.
- Browser events: attempted copy/cut/paste, focus/tab changes, full-screen and media interruptions. Clipboard/context-menu actions are blocked within the app. Browsers cannot completely disable OS shortcuts, other devices, extensions, developer tools or tab switching. No kiosk/security guarantee is claimed.

All flags are imperfect, client-reported, **advisory evidence for human review**. They never change academic marks or automatically fail/reject a candidate. Academic grading remains in `engine.py` using stored answer keys/rubrics.

## Screenshots, AI notes and database records

For supported flags, the client captures a bounded JPEG snapshot from the camera and shared screen when frames are available, before awaiting uploads. It links each snapshot to the already-stored event's sequence number. Missing frames, upload failures and limits are shown rather than inventing evidence. This is **event-triggered screenshots**, not continuous screen/video recording.

- `attempts.state.proctoring`: mode, consent version/time, identity-review status, retention limits and session start. Resume requires fresh permission attestation and does not reset the exam timer or original consent time.
- `events`: server timestamp, sequence, question linkage, allowed numerical observations and a server-generated factual review note. Notes explain the observation and its uncertainty; they are not remote LLM verdicts. Event history remains until account deletion.
- `exam_evidence`: validated/re-encoded JPEG bytes, event link, capture/ingestion time, expiry and `vision_json` containing the source (`camera`/`screen`), observation and advisory note. At most 40 screenshots per attempt, 180 KB each, with retention bounded to 1–90 days (default 30).

Raw camera/screen frames are **not sent to external AI/LLM providers**. No raw audio, continuous recordings, speech content, face embeddings, emotion/personality or demographic predictions are stored. The downloaded public model files do not receive media streams.

The evidence endpoint requires an active owned R1 attempt, recorded consent, current exam session and an existing matching event. It rejects R0 uploads, replayed/duplicate snapshots, invalid JPEGs, incorrect sources, oversized files, exceeded limits and replaced sessions. R1 answer/navigation/SQL/submit endpoints also require `X-Exam-Session` and current camera/mic/screen/full-screen status events. This is browser-reported telemetry, not proof that a malicious client cannot spoof permissions.

## Review, access and deletion

Admin → Exam integrity shows the event timeline, factual review notes, interruption durations, source-labelled screenshots and the retained policy snapshot. Only staff with `integrity_review` scope may see admin evidence. Candidates can retrieve their own retained images and account export includes their retained image data. Employers/public passports do not receive these images. Protected image and admin detail responses use `Cache-Control: no-store`.

Expired image downloads return 404; the existing background cleanup removes expired rows. Account deletion removes linked events and evidence. Consent text distinguishes screenshot retention from the longer-lived assessment event history. Browser-local uploads cannot be guaranteed after a crash or disconnection; monitoring gaps must remain visible and be reviewed fairly.

## Verification and deployment checks

Backend integration tests exercise R0 isolation, explicit/versioned R1 consent, all-four readiness, session replacement, permission interruptions/restoration, evidence/event linking, source validation, JPEG checks, limits, expiry, export and deletion. Browser tests use **mocked media hardware, model outputs and APIs** to test setup, sound/camera flags, snapshots and pause/quit behavior; they do not establish real-world model accuracy.

Before public deployment, test actual desktop browser permission prompts, webcams/microphones, model downloads, CPU/GPU performance, noisy/low-light environments, accessibility/manual-review procedures, PostgreSQL, retention jobs and hosting access controls. Obtain the deployment's applicable privacy/legal approval for biometric comparison and screenshot collection; do not enable camera capture under the R0 policy.
