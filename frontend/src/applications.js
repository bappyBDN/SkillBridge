/** Candidate application and phase-two invitation rules (pure, unit-tested). */

// Mirrors backend APPLICATION_TERMINAL_STAGES; the server re-checks on withdraw.
export const APPLICATION_TERMINAL_STAGES = new Set(["withdrawn", "hired", "rejected", "closed", "offer_declined"]);

export function canWithdrawApplication(application) {
  const status = String(application?.status || "").toLowerCase();
  return Boolean(status) && !APPLICATION_TERMINAL_STAGES.has(status);
}

/** "phase_two_invited" -> "phase two invited" for display when no label exists. */
export function humanizeStatus(status) {
  return String(status || "").replaceAll("_", " ").trim();
}

/**
 * Phase-two invitation states the candidate can see. The backend uses
 * "approved" for a platform-approved invitation awaiting the candidate.
 */
export function inviteAwaitingResponse(invite) {
  const status = String(invite?.status || "").toLowerCase();
  return status === "approved" || status === "pending" || status === "invited";
}

/** Deadline is free text from the company (often an ISO date). */
export function parseInviteDeadline(deadline) {
  if (!deadline || typeof deadline !== "string") return null;
  const time = Date.parse(deadline);
  return Number.isFinite(time) ? time : null;
}

export function inviteDeadlinePassed(invite, now = Date.now()) {
  const time = parseInviteDeadline(invite?.deadline);
  if (time === null) return false;
  // A date-only deadline ("2026-12-01") stays open for that whole day.
  const endOfDay = /^\d{4}-\d{2}-\d{2}$/.test(invite.deadline.trim()) ? time + 24 * 3600 * 1000 - 1 : time;
  return now > endOfDay;
}

export function canRespondToInvite(invite, now = Date.now()) {
  return inviteAwaitingResponse(invite) && !inviteDeadlinePassed(invite, now);
}

export function normalizeInvites(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.filter((item) => item && item.id != null).map((item) => ({ ...item, id: String(item.id) }));
}
