"""Versioned, advisory proctoring rules for Voice AI interviews.

Nothing in this module grades, judges, rejects, fails or blocks a candidate.
It only turns factual observations into a human-review label. The rules live
here (not in the client) so thresholds can be tuned from pilot data.
"""
from __future__ import annotations

import os

PROCTOR_CONSENT_VERSION = "ai-interview-proctoring-v1"

PROCTOR_RULES = {
    "rule_version": "interview-proctor-v1",
    # Server-side limits. The client mirrors these through /proctor/config.
    "event_cooldown_seconds": 30,
    "max_events_per_session": 40,
    "max_shots_per_session": 25,
    "gaze_suppression_ms": 3000,
    "trust_points": {"low": 1, "medium": 2, "high": 4},
    "labels": {"high_trust_max": 3, "medium_max": 8},
    "thresholds": {
        "face_absent": {"min_ms": 4000, "high_ms": 12000},
        "multiple_faces": {"min_ms": 2000},
        "head_turned": {"min_ms": 5000},
        "gaze_away": {"min_ms": 5000, "cumulative_ms": 12000, "window_ms": 30000},
        "gaze_pattern": {"episodes": 3},
    },
    # Default severity per event type. Duration thresholds above override the
    # default for the camera events. The browser reports duration; the SERVER
    # always recomputes the final severity.
    "severity": {
        "face_absent": "medium",
        "multiple_faces": "high",
        "head_turned": "medium",
        "gaze_away": "low",
        "gaze_pattern": "medium",
        "camera_analysis_unavailable": "info",
        "camera_lost": "medium",
        "tab_hidden": "low",
        "tab_visible": "info",
        "window_blur_end": "info",
        "window_blur": "low",
        "fullscreen_exit": "medium",
        "copy": "low",
        "cut": "low",
        "paste": "low",
        "context_menu": "low",
        "printscreen": "low",
        "devtools_shortcut": "low",
        "second_tab": "medium",
        "beforeunload": "low",
        "screen_share_started": "info",
        "screen_share_stopped": "medium",
        "screen_share_unavailable": "medium",
        "fullscreen_enter": "info",
    },
}

SEVERITIES = ("info", "low", "medium", "high")
DETAIL_KEYS = {
    "face_count", "yaw_delta", "pitch_delta", "gaze_x", "gaze_y",
    "cumulative_ms", "window_ms", "episode_id", "model", "reason",
    "source", "surface", "fps", "visible", "duration_ms", "ms",
}


def rule_version() -> str:
    return PROCTOR_RULES["rule_version"]


def shot_retention_days() -> int:
    try:
        return max(1, min(3650, int(os.getenv("AI_INTERVIEW_SHOT_RETENTION_DAYS", "30"))))
    except (TypeError, ValueError):
        return 30


def public_rules() -> dict:
    """The subset/whole config mirrored to the browser for UX timing."""
    return {
        "rule_version": PROCTOR_RULES["rule_version"],
        "event_cooldown_seconds": PROCTOR_RULES["event_cooldown_seconds"],
        "max_events_per_session": PROCTOR_RULES["max_events_per_session"],
        "max_shots_per_session": PROCTOR_RULES["max_shots_per_session"],
        "gaze_suppression_ms": PROCTOR_RULES["gaze_suppression_ms"],
        "thresholds": PROCTOR_RULES["thresholds"],
        "severity": PROCTOR_RULES["severity"],
        "shot_retention_days": shot_retention_days(),
    }


def _clean_detail(detail: dict) -> dict:
    clean = {}
    for key, value in list((detail or {}).items())[:20]:
        if key not in DETAIL_KEYS:
            continue
        if isinstance(value, bool):
            clean[key] = value
        elif isinstance(value, (int, float)):
            clean[key] = round(float(value), 3)
        elif isinstance(value, str):
            clean[key] = value[:100]
    return clean


def _duration(detail: dict, duration_ms) -> float:
    for value in (duration_ms, (detail or {}).get("duration_ms"), (detail or {}).get("ms")):
        try:
            if value is not None:
                return max(0.0, min(float(value), 1_800_000.0))
        except (TypeError, ValueError):
            continue
    return 0.0


def evaluate_event(event_type: str, duration_ms=None, detail=None):
    """Return ``{severity, duration_ms, detail}`` or None when dropped.

    The server never accepts a client-supplied severity: the value is derived
    from the type and duration using PROCTOR_RULES. Events below their minimum
    threshold are ignored (a single glance is never a flag).
    """
    event_type = str(event_type or "").strip().lower()
    if event_type not in PROCTOR_RULES["severity"]:
        return None
    # Gaze patterns are created by the server from repeated episodes.
    if event_type == "gaze_pattern":
        return None
    detail = _clean_detail(detail or {})
    duration = _duration(detail, duration_ms)
    thresholds = PROCTOR_RULES["thresholds"]
    severity = PROCTOR_RULES["severity"].get(event_type, "info")

    if event_type == "face_absent":
        if duration < thresholds["face_absent"]["min_ms"]:
            return None
        severity = "high" if duration >= thresholds["face_absent"]["high_ms"] else "medium"
    elif event_type == "multiple_faces":
        if duration < thresholds["multiple_faces"]["min_ms"]:
            return None
        severity = "high"
    elif event_type == "head_turned":
        if duration < thresholds["head_turned"]["min_ms"]:
            return None
        severity = "medium"
    elif event_type == "gaze_away":
        cumulative = detail.get("cumulative_ms") or 0
        window = detail.get("window_ms") or 0
        sustained = duration >= thresholds["gaze_away"]["min_ms"]
        cumulative_flag = (
            isinstance(cumulative, (int, float))
            and cumulative >= thresholds["gaze_away"]["cumulative_ms"]
            and (not window or window <= thresholds["gaze_away"]["window_ms"])
        )
        if not sustained and not cumulative_flag:
            return None
        severity = "low"
    # Browser/device events keep the configured default severity.
    return {"severity": severity, "duration_ms": duration, "detail": detail}


def trust_label(events, rule_version_value=None) -> dict:
    """Advisory label. Returns raw and after-review numbers.

    Dismissed events are ignored in ``after_review``; confirmed and still
    unreviewed events count. A confirmed high flag forces "Needs review".
    """
    rules = PROCTOR_RULES
    weights = rules["trust_points"]
    labels = rules["labels"]
    version = rule_version_value or rules["rule_version"]

    def summarise(items, use_confirmed=True):
        points = 0
        counts = {}
        reasons = {}
        confirmed_high = False
        for event in items:
            severity = str(event.get("severity") or "info").lower()
            if severity == "info":
                continue
            points += weights.get(severity, 1)
            kind = str(event.get("type") or "unknown")
            counts[kind] = counts.get(kind, 0) + 1
            reasons.setdefault(
                kind, {"type": kind, "severity": severity, "n": 0,
                       "points": 0}
            )
            reasons[kind]["n"] += 1
            reasons[kind]["points"] += weights.get(severity, 1)
            if (use_confirmed and severity == "high"
                    and event.get("review_status") == "confirmed"):
                confirmed_high = True
        if (use_confirmed and confirmed_high) or points >= 9:
            label = "Needs review"
        elif points >= 4:
            label = "Medium"
        else:
            label = "High trust"
        return {
            "label": label,
            "points": round(points, 2),
            "confirmed_high": confirmed_high,
            "reasons": sorted(reasons.values(), key=lambda item: item["type"]),
            "counts": counts,
            "n": len(items),
        }

    all_events = list(events or [])
    raw = summarise(all_events, use_confirmed=False)
    after = summarise([event for event in all_events
                       if str(event.get("review_status") or "unreviewed") != "dismissed"])
    return {
        "rule_version": version,
        "weights": weights,
        "thresholds": labels,
        "raw": raw,
        "after_review": after,
    }


def confirmed_high_count(events) -> int:
    return sum(1 for event in events or []
               if event.get("severity") == "high"
               and event.get("review_status") == "confirmed")


def unresolved_appeals(events) -> int:
    return sum(1 for event in events or []
               if event.get("appeal_at")
               and str(event.get("review_status") or "unreviewed") == "unreviewed")
