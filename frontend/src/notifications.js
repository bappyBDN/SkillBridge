/**
 * Candidate notification rules.
 *
 * A notification is a per-candidate event about an assessment the candidate
 * actually finished. Starting or abandoning an attempt, or waiting for the
 * first review, is not an event and must never ring the bell or show a score.
 */

const TERMINAL_REVIEW = new Set(["invalidated", "needs_more_info"]);

export function isPublishedAttempt(attempt) {
  return attempt?.finalized === true || attempt?.publication?.stage === "published";
}

export function hasAssessmentNotification(attempt) {
  if (!attempt || attempt.status !== "done") return false;
  if (isPublishedAttempt(attempt)) return true;
  if (TERMINAL_REVIEW.has(attempt.review_decision)) return true;
  return Boolean(attempt.appeal_decision);
}

export function notificationTimestamp(attempt) {
  return Math.max(
    Number(attempt?.reviewed_at) || 0,
    Number(attempt?.appeal_decided_at) || 0,
    Number(attempt?.finished) || 0,
  );
}

/** Newest notification first; attempts without an event are dropped. */
export function assessmentNotificationItems(attempts) {
  return (attempts || [])
    .filter(hasAssessmentNotification)
    .sort((a, b) => notificationTimestamp(b) - notificationTimestamp(a));
}
