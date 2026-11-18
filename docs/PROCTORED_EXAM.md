# Proctored exam (always on)

Every SkillBridge exam — the Initial exam and every Profile retake — is proctored.
There is **no R0 / R1 mode switch** any more. Camera, microphone, entire-screen
sharing, full-screen, monitoring consent and a face check (or an acknowledged
manual identity review) are always required.

```dotenv
EVIDENCE_RETENTION_DAYS=30   # screenshot retention, 1–90 days
```

`ASSESSMENT_PROCTORING_MODE` was removed. Setting it has no effect (a backend test
checks that `ASSESSMENT_PROCTORING_MODE=r0` no longer turns the camera off). No AI
provider key is needed: the vision and face models run in the candidate's browser.

## Change log — 2026-11-18

| Area | Before | Now |
| --- | --- | --- |
| Policy | `proctoring.policy()` returned camera-free `r0` unless `ASSESSMENT_PROCTORING_MODE=r1` | Always returns `mode: "proctored"` with all four required devices |
| Consent version | `r1-proctoring-v1` | `proctoring-v1` (old value still accepted for saved attempts) |
| Saved attempts | `mode: "r1"` / `"r0"` | `"r1"` is still treated as proctored; attempts with no policy are `legacy_unproctored` |
| Non-blueprint (old adaptive) start | Allowed in R0 | Refused with `assessment_blueprint_required` |
| Error codes | `r1_proctoring_consent_required`, `r1_all_four_permissions_required`, `r1_identity_check_or_manual_review_acknowledgement_required`, `r1_monitoring_restore_required:*`, `r1_entire_screen_required`, `r1_evidence_consent_required` | Same without the `r1_` prefix; the permissions error is `camera_microphone_screen_fullscreen_required` |
| Frontend files | `useR1Devices.js`, `useR1Monitoring.js`, `r1-proctoring.css` | `useExamDevices.js`, `useExamMonitoring.js`, `proctoring.css` |
| Model loading | Only when R1 was enabled | Always: in the background once the candidate portal loads, and again when the exam setup page opens |
| Start gate | Permissions only | Permissions **and** "AI models loaded" (face + phone detection) |
| Exam room | Camera panel only in R1 | Always: questions + Submit/Quit on the left, question in the centre, live camera and every monitoring flag on the right |
| Tests | `tests/test_proctoring_r1.py` | `tests/test_proctoring.py`; `frontend/tests/e2e/exam-setup.spec.js` runs every case through the proctored flow |

Product release naming ("R0 prototype" in the API title, the passport issuer and
the general consent version `r0-2`) is unrelated to proctoring and was left as is.

## Skill Journey → Initial exam setup

The setup page (Skill Journey → Initial exam, or Profile retake) runs in this order:

1. **AI models load first.** Loading starts in the background as soon as the
   candidate portal opens and is re-triggered when the setup page opens. Two status
   chips show *Face & phone detection* (MediaPipe face landmarker + object detector)
   and *Face verification model* (face-api). If a load fails, **Retry loading models**
   appears. Start stays disabled until face & phone detection is ready, so the exam
   page never waits on a download.
2. **Monitoring consent** (`proctoring-v1`). Camera, microphone and screen-share
   buttons stay disabled until consent is given.
3. **Camera and microphone.** The camera is accepted only once live frames decode;
   the microphone only once local level analysis runs. A live preview with face and
   phone chips confirms the models can see the candidate.
4. **Identity verification.** The live face is compared with the profile photo in
   the browser. If there is no photo, no match or the model is unavailable, the
   candidate can acknowledge referral to human review. This is never an automatic
   rejection.
5. **Screen sharing (entire screen)**, then **full-screen** last, because the share
   picker can drop full-screen.

## Exam room layout

- **Left:** question number grid (current / answered / skipped / not answered /
  flagged), legend, then **Submit assessment** and **Quit assessment**.
- **Centre:** question card (type, marks, **Flag Question**), options or answer
  editor, and **Previous / Next**.
- **Right:** live camera, then **Monitoring flags** with every signal on one row:
  camera, microphone, face verification result, face (one / none / multiple),
  phone, voice, screen share, full screen, tab focus, copy/paste and marked
  questions. Recent alerts and restore buttons appear underneath.

Losing the camera, microphone, screen share, full-screen or the tab pauses the
answer controls; the server deadline continues. Restore the device or press
**Quit assessment**, which always works.

## What is monitored

- MediaPipe face landmarks: a sustained missing face or multiple faces. No emotion,
  attention, personality, demographic or identity inference is made by the live monitor.
- MediaPipe object detection: a possible phone.
- Web Audio RMS level: a sustained level above `0.028` for at least one second,
  throttled to one signal per 15 seconds. This is **not speech recognition**.
- Browser events: blocked copy/cut/paste, focus/tab changes, full-screen and media
  interruptions. Browsers cannot fully stop OS shortcuts, other devices or tab switching.

All flags are client-reported, **advisory evidence for human review**. They never
change marks or fail a candidate automatically. Scores still come only from
`backend/engine.py`.

## Screenshots and records

For supported flags the client captures one camera and one screen JPEG and links them
to the stored event. These are **event-triggered screenshots**, not continuous recording.

- `attempts.state.proctoring`: policy snapshot, consent version and time, identity status, session start.
- `events`: timestamp, sequence, numerical observations and a factual review note.
- `exam_evidence`: re-encoded JPEG, event link, expiry. At most 40 per attempt, 180 KB each.

Raw frames are never sent to external AI providers. No raw audio, continuous video,
speech content or face embeddings are stored. Admin → Exam integrity shows the timeline
and screenshots to staff with `integrity_review` scope; employers and public passports
never see them. Account deletion removes events and evidence.

## Verification

- Backend: `cd backend && python -m pytest -q tests`
- Browser: `cd frontend && npx playwright test tests/e2e/exam-setup.spec.js`

Browser tests use **mocked** media hardware and model outputs, so they test the workflow,
not real-world model accuracy. Before deployment, test real webcams and microphones,
model downloads, low-light and noisy rooms, and the manual-review procedure.
