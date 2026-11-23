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

/**
 * The honesty (integrity) review did not pass. This is a terminal outcome for
 * the candidate, decided by a human reviewer, and it can be appealed.
 */
export function isHonestyRejected(attempt) {
  return attempt?.honesty_status === "rejected" || attempt?.honesty?.status === "rejected"
    || attempt?.publication_stage === "honesty_rejected" || attempt?.publication?.stage === "honesty_rejected";
}

export function hasAssessmentNotification(attempt) {
  if (!attempt || attempt.status !== "done") return false;
  if (isPublishedAttempt(attempt)) return true;
  if (isHonestyRejected(attempt)) return true;
  if (TERMINAL_REVIEW.has(attempt.review_decision)) return true;
  return Boolean(attempt.appeal_decision);
}

export function notificationTimestamp(attempt) {
  return Math.max(
    Number(attempt?.reviewed_at) || 0,
    Number(attempt?.appeal_decided_at) || 0,
    Number(attempt?.honesty?.reviewed_at) || 0,
    Number(attempt?.finished) || 0,
  );
}

/** Newest notification first; attempts without an event are dropped. */
export function assessmentNotificationItems(attempts) {
  return (attempts || [])
    .filter(hasAssessmentNotification)
    .sort((a, b) => notificationTimestamp(b) - notificationTimestamp(a));
}

/* ---------- read / unread ---------- */

/**
 * Identity of one notification *event*. A later decision on the same attempt
 * (re-review, appeal outcome, publication) changes the key, so it shows as
 * unread again instead of being hidden by an earlier "seen".
 */
export function notificationKey(attempt) {
  if (!attempt) return "";
  return [
    attempt.id,
    attempt.review_decision || "",
    Number(attempt.reviewed_at) || 0,
    attempt.appeal_decision || "",
    Number(attempt.appeal_decided_at) || 0,
    isPublishedAttempt(attempt) ? "published" : "",
    isHonestyRejected(attempt) ? `honesty_rejected@${Number(attempt.honesty?.reviewed_at) || 0}` : "",
  ].join(":");
}

export function unreadNotificationItems(items, seenKeys) {
  const seen = seenKeys instanceof Set ? seenKeys : new Set(seenKeys || []);
  return (items || []).filter((attempt) => !seen.has(notificationKey(attempt)));
}

const SEEN_LIMIT = 200;
const seenStorageKey = (ownerKey) => `sb_seen_notifications:${ownerKey || "anonymous"}`;

/** Seen keys survive reloads per account. Storage can be missing or blocked. */
export function loadSeenNotifications(ownerKey, storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(seenStorageKey(ownerKey)) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/** Returns the merged set; persisting is best effort. */
export function markNotificationsSeen(ownerKey, seen, items, storage = globalThis.localStorage) {
  const next = new Set(seen);
  for (const attempt of items || []) next.add(notificationKey(attempt));
  try {
    storage?.setItem(seenStorageKey(ownerKey), JSON.stringify([...next].slice(-SEEN_LIMIT)));
  } catch {
    /* private mode or quota: the in-memory set still clears the badge */
  }
  return next;
}

/* ---------- live updates ---------- */

/**
 * True while a finished attempt can still produce a notification without the
 * candidate doing anything: a review, a publication or an appeal outcome is
 * pending. The workspace polls only while this holds.
 */
export function awaitingAssessmentUpdate(attempt) {
  if (!attempt || attempt.status !== "done" || isPublishedAttempt(attempt)) return false;
  // Rejections are terminal: only a pending appeal can still change them.
  if (attempt.review_decision === "invalidated" || isHonestyRejected(attempt)) {
    return Boolean(attempt.appeal) && attempt.appeal_decision !== "upheld";
  }
  // needs_more_info keeps polling, before and after the candidate replies: the
  // reviewer can still decide. Who has to act is answered by assessmentWaitingOn.
  return true;
}

/** True when the reviewer asked for more information and no reply was sent yet. */
export function needsCandidateResponse(attempt) {
  return attempt?.status === "done" && attempt.review_decision === "needs_more_info" && !attempt.review_response;
}

/**
 * Who the next step belongs to: "candidate" (reply to the reviewer, or add the
 * information an appeal reviewer asked for), "reviewer" (a review, reply or
 * appeal is pending), or null when
 * nothing more is expected.
 */
export function assessmentWaitingOn(attempt) {
  if (!attempt || attempt.status !== "done" || isPublishedAttempt(attempt)) return null;
  if (needsCandidateResponse(attempt)) return "candidate";
  if (attempt.review_decision === "invalidated" || isHonestyRejected(attempt)) {
    if (!attempt.appeal) return null; // terminal; an appeal is optional
    if (attempt.appeal_decision === "needs_more_info") return "candidate";
    return attempt.appeal_decision === "upheld" ? null : "reviewer";
  }
  return "reviewer";
}

export function shouldPollForNotifications(attempts) {
  return (attempts || []).some(awaitingAssessmentUpdate);
}

/* ---------- server notification center (/api/notifications) ---------- */

/** Accepts whatever the server returned; never throws. */
export function normalizeServerNotifications(payload) {
  const raw = Array.isArray(payload?.items) ? payload.items : [];
  const items = raw
    .filter((item) => item && (typeof item.id === "string" || typeof item.id === "number"))
    .map((item) => ({
      id: String(item.id),
      kind: typeof item.kind === "string" ? item.kind : "",
      title: typeof item.title === "string" ? item.title : "",
      body: typeof item.body === "string" ? item.body : "",
      link: typeof item.link === "string" ? item.link : "",
      created: Number(item.created) || 0,
      read_at: item.read_at ? Number(item.read_at) || item.read_at : null,
    }));
  const counted = items.filter((item) => !item.read_at).length;
  const unread = Number.isFinite(Number(payload?.unread)) ? Math.max(0, Number(payload.unread)) : counted;
  return { items, unread };
}

export function unreadServerIds(items) {
  return (items || []).filter((item) => item && !item.read_at).map((item) => item.id);
}

/** Optimistically mark ids read; the unread count never goes below zero. */
export function markServerItemsRead(state, ids, now = Date.now() / 1000) {
  const wanted = new Set(ids || []);
  let changed = 0;
  const items = (state?.items || []).map((item) => {
    if (!wanted.has(item.id) || item.read_at) return item;
    changed += 1;
    return { ...item, read_at: now };
  });
  return { items, unread: Math.max(0, (Number(state?.unread) || 0) - changed) };
}

/**
 * One newest-first feed of assessment events (rich rendering) and server
 * notifications (title/body/link). Each entry: { source, key, ts, item }.
 */
export function mergeNotificationFeed(assessmentItems, serverItems) {
  const feed = [
    ...(assessmentItems || []).map((attempt) => ({
      source: "assessment", key: "a:" + notificationKey(attempt), ts: notificationTimestamp(attempt), item: attempt,
    })),
    ...(serverItems || []).map((item) => ({ source: "server", key: "s:" + item.id, ts: Number(item.created) || 0, item })),
  ];
  return feed
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.ts - a.entry.ts || a.index - b.index)
    .map(({ entry }) => entry);
}

export function notificationBadgeCount(unreadAssessmentCount, serverUnread) {
  return Math.max(0, Number(unreadAssessmentCount) || 0) + Math.max(0, Number(serverUnread) || 0);
}

/** Section hints a server notification may carry, per workspace. */
export const NOTIFICATION_LINKS = {
  candidate: { applications: "applications", jobs: "jobs", exams: "exams", profile: "profile" },
  company: {
    "company-applications": "applicants", "company-jobs": "jobs",
    "company-team": "team", "company-verification": "settings",
  },
  admin: {
    "admin-reviews": "assessments", "admin-companies": "companies", "admin-jobs": "jobs",
    "admin-billing": "billing", "admin-identity": "identity",
  },
};

/** Workspace section for a link hint, or null when it does not belong here. */
export function sectionForNotificationLink(link, workspace, available) {
  const section = NOTIFICATION_LINKS[workspace]?.[link] || null;
  if (!section) return null;
  if (available && !available.includes(section)) return null;
  return section;
}
