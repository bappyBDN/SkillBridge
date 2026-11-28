/**
 * Pure proctoring helpers shared by the interview UI and unit tests.
 * Thresholds come from the server (/proctor/config); the fallbacks below only
 * keep the UI usable if that request fails.
 */

export const DEFAULT_PROCTOR_RULES = {
  rule_version: "interview-proctor-v1",
  event_cooldown_seconds: 30,
  max_events_per_session: 40,
  max_shots_per_session: 25,
  gaze_suppression_ms: 3000,
  thresholds: {
    face_absent: { min_ms: 4000, high_ms: 12000 },
    multiple_faces: { min_ms: 2000 },
    head_turned: { min_ms: 5000, degrees: 25 },
    gaze_away: { min_ms: 5000, cumulative_ms: 12000, window_ms: 30000, deviation: 0.18 },
    gaze_pattern: { episodes: 3 },
  },
  severity: {
    face_absent: "medium",
    multiple_faces: "high",
    head_turned: "medium",
    gaze_away: "low",
    camera_analysis_unavailable: "info",
    camera_lost: "medium",
    tab_hidden: "low",
    window_blur: "low",
    fullscreen_exit: "medium",
    copy: "low",
    cut: "low",
    paste: "low",
    context_menu: "low",
    printscreen: "low",
    devtools_shortcut: "low",
    second_tab: "medium",
    beforeunload: "low",
    screen_share_started: "info",
    screen_share_stopped: "medium",
    screen_share_unavailable: "medium",
    fullscreen_enter: "info",
  },
};

export function mergeProctorRules(remote) {
  if (!remote || typeof remote !== "object") return DEFAULT_PROCTOR_RULES;
  return {
    ...DEFAULT_PROCTOR_RULES,
    ...remote,
    thresholds: { ...DEFAULT_PROCTOR_RULES.thresholds, ...(remote.thresholds || {}) },
    severity: { ...DEFAULT_PROCTOR_RULES.severity, ...(remote.severity || {}) },
  };
}

/** Reading-time suppression after a new question appears. */
export function isGazeSuppressed(questionShownAt, now, suppressionMs) {
  if (!questionShownAt) return false;
  return now - Number(questionShownAt) < Math.max(0, Number(suppressionMs || 0));
}

/**
 * ~2.5 fps normally; slower when a frame costs too much or the tab is hidden.
 * Returns the next delay in milliseconds.
 */
export function analysisDelayMs(processingMs, hidden = false) {
  if (hidden) return 1000;
  const cost = Math.max(0, Number(processingMs || 0));
  if (cost > 250) return 900;
  if (cost > 120) return 650;
  return 400;
}

/** Which blocking overlay (if any) the interview must show. */
export function proctorOverlay({ level, fullscreenActive, cameraLive, shareLive, secondTab }) {
  if (level === "off" || level === "light") return null;
  if (secondTab) return { reason: "second_tab", title: "Another tab has this interview open" };
  if (!fullscreenActive) return { reason: "fullscreen_exit", title: "Return to full screen to continue" };
  if (level === "standard" || level === "strict") {
    if (!cameraLive) return { reason: "camera_lost", title: "Your camera is not available" };
  }
  if (level === "strict" && !shareLive) {
    return { reason: "screen_share_stopped", title: "Share your entire screen to continue" };
  }
  return null;
}
