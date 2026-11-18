"""Exam proctoring policy. Every assessment is proctored.

Camera, microphone, entire-screen sharing and full-screen are always required,
together with explicit monitoring consent and a face check (or an acknowledged
manual identity review). There is no camera-free variant and no mode switch.

No grades, misconduct verdicts, emotion or demographic inference live here.
Only bounded, factual observations and human-review notes are retained, and
flags never fail a candidate automatically.
"""
import os

MODE = "proctored"
# Attempts stored before the single policy existed carry the old label.
_LEGACY_PROCTORED = {"r1"}
CONSENT_VERSION = "proctoring-v1"
_LEGACY_CONSENT = {"r1-proctoring-v1"}
REQUIRED = ("screen", "fullscreen", "camera", "microphone")
NOTES = {
    "ai_no_face": "The on-device face model reported no face for a sustained interval. Occlusion, lighting or model error may explain this; human review is required.",
    "ai_multiple_faces": "The on-device face model reported multiple faces. This observation does not identify people or establish misconduct.",
    "ai_phone_detected": "The on-device object model reported a possible phone. A reviewer must check the snapshot and context.",
    "ai_audio_level": "Microphone RMS loudness exceeded the disclosed threshold for a sustained interval. This is not speech recognition and cannot identify the sound, speaker or intent.",
    "tab_hidden": "The browser reported the assessment tab hidden. The app cannot determine which other application was used or why.",
    "blur": "The assessment window lost focus. Browser prompts and accessibility tools may also cause this event.",
    "fullscreen_exit": "The browser reported an exit from full-screen. No automatic misconduct decision is made.",
    "copy": "A copy action was blocked within the assessment page.",
    "cut": "A cut action was blocked within the assessment page.",
    "paste": "A paste action was blocked within the assessment page.",
    "camera_stopped": "The webcam track stopped. This may be a permission or hardware interruption.",
    "microphone_stopped": "The microphone track stopped. This may be a permission or hardware interruption.",
    "screen_share_stopped": "The browser screen-sharing track stopped.",
    "screen_share_unavailable": "A live screen-sharing track was unavailable.",
    "identity_mismatch": "Local face comparison did not meet its similarity threshold. This is an advisory comparison, not proof of impersonation.",
    "identity_skipped": "Local face comparison was unavailable and was acknowledged for manual identity review.",
}
EVIDENCE_EVENTS = set(NOTES)


def is_proctored(saved_policy) -> bool:
    """True for every attempt started under the proctoring policy (old or new label)."""
    mode = (saved_policy or {}).get("mode")
    return mode == MODE or mode in _LEGACY_PROCTORED


def consent_ok(version) -> bool:
    return version == CONSENT_VERSION or version in _LEGACY_CONSENT


def policy():
    try:
        days = max(1, min(90, int(os.getenv("EVIDENCE_RETENTION_DAYS", "30"))))
    except ValueError:
        days = 30
    return {"mode": MODE, "consent_version": CONSENT_VERSION,
            "required": list(REQUIRED), "retention_days": days,
            "max_snapshots": 40, "max_snapshot_bytes": 180 * 1024,
            "audio_recorded": False, "continuous_video_recorded": False,
            "external_ai_upload": False, "advisory_only": True}


def validate_start(body, required_policy, now):
    from fastapi import HTTPException
    if not is_proctored(required_policy):
        # Only attempts created before proctoring existed reach this branch.
        return {"mode": "legacy_unproctored"}
    if not body or not consent_ok(body.proctoring_consent):
        raise HTTPException(409, "proctoring_consent_required")
    if any(body.proctoring_ready.get(key) is not True for key in REQUIRED):
        raise HTTPException(409, "camera_microphone_screen_fullscreen_required")
    if body.identity_status not in ("verified", "needs_review"):
        raise HTTPException(409, "identity_check_or_manual_review_acknowledgement_required")
    return {**required_policy, "consented_at": now, "identity_status": body.identity_status,
            "session_started_at": now}


def observation(event_type, source=None, metadata=None):
    metadata = metadata or {}
    data = {"summary": NOTES.get(event_type, "Browser-reported assessment event; review context before drawing conclusions."),
            "event_type": event_type, "advisory": True, "client_reported": True,
            "method": "on_device_observation_with_review_note_v1"}
    if source:
        data["source"] = source
    for key in ("level", "threshold", "duration_ms", "faces", "confidence"):
        value = metadata.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            data[key] = value
    return data
