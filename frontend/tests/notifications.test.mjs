import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessmentNotificationItems,
  assessmentWaitingOn,
  awaitingAssessmentUpdate,
  hasAssessmentNotification,
  isHonestyRejected,
  isPublishedAttempt,
  loadSeenNotifications,
  markNotificationsSeen,
  markServerItemsRead,
  mergeNotificationFeed,
  needsCandidateResponse,
  normalizeServerNotifications,
  notificationBadgeCount,
  notificationKey,
  notificationTimestamp,
  sectionForNotificationLink,
  shouldPollForNotifications,
  unreadNotificationItems,
  unreadServerIds,
} from "../src/notifications.js";

const attempt = (overrides = {}) => ({ id: "a", kind: "pre", status: "done", finished: 100, ...overrides });

/* ---------- attempts that must never notify ---------- */

test("unfinished attempts never notify, whatever other fields exist", () => {
  for (const status of ["active", "quit", "in_progress", "", undefined]) {
    const candidate = attempt({ status, review_decision: "approved", finalized: true, overall: 90 });
    assert.equal(hasAssessmentNotification(candidate), false, `status=${status}`);
  }
});

test("missing and null attempts are ignored", () => {
  assert.deepEqual(assessmentNotificationItems(undefined), []);
  assert.deepEqual(assessmentNotificationItems(null), []);
  assert.deepEqual(assessmentNotificationItems([]), []);
  assert.deepEqual(assessmentNotificationItems([null, undefined]), []);
});

test("a finished attempt with no review yet is not a notification", () => {
  for (const review_decision of [null, undefined, "", "pending"]) {
    const waiting = attempt({ overall: null, review_decision, finalized: false });
    assert.equal(hasAssessmentNotification(waiting), false, `decision=${review_decision}`);
  }
});

test("an approved review that is not published yet stays quiet", () => {
  const approvedOnly = attempt({ overall: 86, review_decision: "approved", finalized: false });
  assert.equal(isPublishedAttempt(approvedOnly), false);
  assert.equal(hasAssessmentNotification(approvedOnly), false);
});

test("unknown or removed decisions do not notify unless published", () => {
  assert.equal(hasAssessmentNotification(attempt({ review_decision: "superseded" })), false);
  assert.equal(hasAssessmentNotification(attempt({ appeal_decision: "" })), false);
});

test("published flag alone is not enough if the attempt was never finished", () => {
  assert.equal(hasAssessmentNotification(attempt({ status: "quit", finalized: true })), false);
});

/* ---------- attempts that must notify ---------- */

test("a published result notifies with the attempt id", () => {
  const published = attempt({ id: "published", overall: 86, review_decision: "approved", finalized: true });
  assert.equal(isPublishedAttempt(published), true);
  assert.equal(hasAssessmentNotification(published), true);
  assert.deepEqual(assessmentNotificationItems([published]).map((item) => item.id), ["published"]);
});

test("publication.stage=published is accepted when the finalized flag is absent", () => {
  const published = attempt({ id: "stage-only", publication: { stage: "published", ready: true } });
  assert.equal(hasAssessmentNotification(published), true);
});

test("terminal review decisions notify even before publication", () => {
  for (const decision of ["invalidated", "needs_more_info"]) {
    const reviewed = attempt({ id: decision, review_decision: decision, finalized: false });
    assert.equal(hasAssessmentNotification(reviewed), true, decision);
  }
});

test("a decided appeal notifies even without a published score", () => {
  const appealed = attempt({ review_decision: "invalidated", appeal_decision: "overturned", appeal_decided_at: 700 });
  assert.equal(hasAssessmentNotification(appealed), true);
});

/* ---------- ordering and input safety ---------- */

test("notifications are ordered by their own latest event", () => {
  const items = assessmentNotificationItems([
    attempt({ id: "older-published", finalized: true, finished: 100, reviewed_at: 150 }),
    attempt({ id: "appeal-event", review_decision: "invalidated", finished: 50, appeal_decided_at: 900 }),
    attempt({ id: "newest-published", finalized: true, finished: 800, reviewed_at: 850 }),
  ]);
  assert.deepEqual(items.map((item) => item.id), ["appeal-event", "newest-published", "older-published"]);
});

test("equal event timestamps keep a stable order", () => {
  const items = assessmentNotificationItems([
    attempt({ id: "first", finalized: true, finished: 100 }),
    attempt({ id: "second", finalized: true, finished: 100 }),
  ]);
  assert.equal(items.length, 2);
});

test("filtering never mutates the caller's attempt list", () => {
  const attempts = [
    attempt({ id: "a", status: "active" }),
    attempt({ id: "b", finalized: true }),
    attempt({ id: "c", review_decision: "invalidated" }),
  ];
  const before = attempts.map((item) => item.id);
  assessmentNotificationItems(attempts);
  assert.deepEqual(attempts.map((item) => item.id), before);
});

test("notificationTimestamp falls back to the finish time", () => {
  assert.equal(notificationTimestamp(attempt({ finished: 42 })), 42);
  assert.equal(notificationTimestamp(attempt({ finished: 42, reviewed_at: 80 })), 80);
  assert.equal(notificationTimestamp(attempt({ finished: 42, appeal_decided_at: 90 })), 90);
  assert.equal(notificationTimestamp(attempt({ finished: 42, reviewed_at: 80, appeal_decided_at: 90 })), 90);
  assert.equal(notificationTimestamp(undefined), 0);
});


/* ---------- read / unread ---------- */

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}

test("opening the panel marks the current events as read, per account", () => {
  const storage = memoryStorage();
  const items = [attempt({ id: "p", finalized: true, reviewed_at: 5 })];
  assert.equal(unreadNotificationItems(items, loadSeenNotifications("a@x", storage)).length, 1);
  markNotificationsSeen("a@x", new Set(), items, storage);
  assert.equal(unreadNotificationItems(items, loadSeenNotifications("a@x", storage)).length, 0);
  assert.equal(unreadNotificationItems(items, loadSeenNotifications("b@x", storage)).length, 1);
});

test("a new decision on an already-read attempt is unread again", () => {
  const rejected = attempt({ id: "r", review_decision: "invalidated", reviewed_at: 5, appeal: "network" });
  const seen = markNotificationsSeen("a@x", new Set(), [rejected], memoryStorage());
  const decided = { ...rejected, appeal_decision: "overturned", appeal_decided_at: 9 };
  assert.notEqual(notificationKey(rejected), notificationKey(decided));
  assert.deepEqual(unreadNotificationItems([decided], seen).map((item) => item.id), ["r"]);
});

test("blocked or corrupt storage never breaks the badge", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  assert.equal(loadSeenNotifications("a@x", throwing).size, 0);
  const next = markNotificationsSeen("a@x", new Set(), [attempt({ finalized: true })], throwing);
  assert.equal(next.size, 1);
  const corrupt = memoryStorage();
  corrupt.setItem("sb_seen_notifications:a@x", "{not json");
  assert.equal(loadSeenNotifications("a@x", corrupt).size, 0);
  assert.equal(loadSeenNotifications("a@x", undefined).size, 0);
});

/* ---------- live updates ---------- */

test("the workspace polls while a review, publication or appeal is pending", () => {
  assert.equal(awaitingAssessmentUpdate(attempt({ review_decision: null })), true);
  assert.equal(awaitingAssessmentUpdate(attempt({ review_decision: "approved", finalized: false })), true);
  assert.equal(awaitingAssessmentUpdate(attempt({ review_decision: "needs_more_info" })), true);
  assert.equal(awaitingAssessmentUpdate(attempt({ review_decision: "invalidated", appeal: "please" })), true);
  assert.equal(awaitingAssessmentUpdate(attempt({ review_decision: "invalidated", appeal: "please", appeal_decision: "overturned" })), true);
});

test("polling stops once nothing can change without the candidate", () => {
  assert.equal(awaitingAssessmentUpdate(attempt({ finalized: true })), false);
  assert.equal(awaitingAssessmentUpdate(attempt({ review_decision: "invalidated" })), false);
  assert.equal(awaitingAssessmentUpdate(attempt({ review_decision: "invalidated", appeal: "x", appeal_decision: "upheld" })), false);
  assert.equal(awaitingAssessmentUpdate(attempt({ status: "active" })), false);
  assert.equal(shouldPollForNotifications(undefined), false);
  assert.equal(shouldPollForNotifications([attempt({ finalized: true }), attempt({ id: "w" })]), true);
});

/* ---------- needs more information ---------- */

test("needs_more_info asks the candidate to act until a reply is sent", () => {
  const asked = attempt({ review_decision: "needs_more_info", reviewed_at: 10 });
  assert.equal(needsCandidateResponse(asked), true);
  assert.equal(assessmentWaitingOn(asked), "candidate");
  const replied = { ...asked, review_response: { note: "Network dropped at Q4", created: 20 } };
  assert.equal(needsCandidateResponse(replied), false);
  assert.equal(assessmentWaitingOn(replied), "reviewer");
});

test("needs_more_info keeps polling before and after the reply", () => {
  const asked = attempt({ review_decision: "needs_more_info" });
  assert.equal(awaitingAssessmentUpdate(asked), true);
  assert.equal(awaitingAssessmentUpdate({ ...asked, review_response: { note: "x", created: 1 } }), true);
});

test("sending a reply does not create a new unread event", () => {
  const asked = attempt({ review_decision: "needs_more_info", reviewed_at: 150 });
  const replied = { ...asked, review_response: { note: "details", created: 900 } };
  assert.equal(notificationKey(asked), notificationKey(replied));
  assert.equal(notificationTimestamp(replied), 150);
});

/* ---------- honesty review rejected ---------- */

test("an honesty rejection is a terminal, notified outcome", () => {
  const rejected = attempt({ honesty: { status: "rejected", reason: "Second person visible", reviewed_at: 500 } });
  assert.equal(isHonestyRejected(rejected), true);
  assert.equal(hasAssessmentNotification(rejected), true);
  assert.equal(awaitingAssessmentUpdate(rejected), false);
  assert.equal(assessmentWaitingOn(rejected), null);
  assert.equal(notificationTimestamp(rejected), 500);
  assert.deepEqual(assessmentNotificationItems([rejected]).map((item) => item.id), ["a"]);
});

test("publication.stage=honesty_rejected is accepted without the honesty object", () => {
  const rejected = attempt({ publication: { stage: "honesty_rejected" } });
  assert.equal(isHonestyRejected(rejected), true);
  assert.equal(hasAssessmentNotification(rejected), true);
});

test("an honesty rejection under appeal polls until the appeal is decided", () => {
  const appealed = attempt({ honesty: { status: "rejected", reviewed_at: 5 }, appeal: "My camera froze" });
  assert.equal(awaitingAssessmentUpdate(appealed), true);
  assert.equal(assessmentWaitingOn(appealed), "reviewer");
  assert.equal(awaitingAssessmentUpdate({ ...appealed, appeal_decision: "upheld" }), false);
  assert.equal(assessmentWaitingOn({ ...appealed, appeal_decision: "needs_more_info" }), "candidate");
});

test("an honesty rejection changes the event key so it shows as unread", () => {
  const pending = attempt({ honesty: { status: "pending" } });
  const rejected = attempt({ honesty: { status: "rejected", reviewed_at: 9 } });
  assert.notEqual(notificationKey(pending), notificationKey(rejected));
  assert.equal(hasAssessmentNotification(pending), false);
  assert.equal(isHonestyRejected(pending), false);
  assert.equal(isHonestyRejected(undefined), false);
});

/* ---------- server notification center ---------- */

test("server payloads are normalised and never throw", () => {
  assert.deepEqual(normalizeServerNotifications(undefined), { items: [], unread: 0 });
  assert.deepEqual(normalizeServerNotifications({ items: "nope" }), { items: [], unread: 0 });
  const state = normalizeServerNotifications({
    items: [
      { id: 7, kind: "application_stage", title: "Moved to review", body: "Data Analyst", link: "applications", created: 300, read_at: null },
      { id: "b", title: "Old", created: 100, read_at: 150 },
      null,
      { title: "no id" },
    ],
    unread: 1,
  });
  assert.deepEqual(state.items.map((item) => item.id), ["7", "b"]);
  assert.equal(state.unread, 1);
  assert.equal(normalizeServerNotifications({ items: state.items }).unread, 1, "falls back to counting");
});

test("marking server items read is optimistic and never goes negative", () => {
  const state = normalizeServerNotifications({ items: [{ id: "x", created: 1 }, { id: "y", created: 2 }], unread: 2 });
  assert.deepEqual(unreadServerIds(state.items), ["x", "y"]);
  const next = markServerItemsRead(state, ["x", "missing"], 99);
  assert.equal(next.unread, 1);
  assert.equal(next.items.find((item) => item.id === "x").read_at, 99);
  assert.equal(markServerItemsRead(next, ["x"]).unread, 1, "already read is not counted twice");
  assert.equal(markServerItemsRead({ items: [{ id: "z" }], unread: 0 }, ["z"]).unread, 0);
});

test("assessment and server notifications merge newest first", () => {
  const published = attempt({ id: "p", finalized: true, finished: 100, reviewed_at: 200 });
  const feed = mergeNotificationFeed([published], [
    { id: "new", created: 300 },
    { id: "old", created: 50 },
  ]);
  assert.deepEqual(feed.map((entry) => `${entry.source}:${entry.item.id}`), ["server:new", "assessment:p", "server:old"]);
  assert.deepEqual(mergeNotificationFeed(undefined, undefined), []);
});

test("badge counts unread assessment events plus server unread", () => {
  assert.equal(notificationBadgeCount(2, 3), 5);
  assert.equal(notificationBadgeCount(0, undefined), 0);
  assert.equal(notificationBadgeCount(-1, -4), 0);
});

test("notification links resolve only to sections of the current workspace", () => {
  assert.equal(sectionForNotificationLink("applications", "candidate"), "applications");
  assert.equal(sectionForNotificationLink("company-applications", "company"), "applicants");
  assert.equal(sectionForNotificationLink("company-team", "company", ["overview", "jobs"]), null, "hidden section");
  assert.equal(sectionForNotificationLink("admin-reviews", "admin", ["assessments"]), "assessments");
  assert.equal(sectionForNotificationLink("admin-reviews", "candidate"), null);
  assert.equal(sectionForNotificationLink("", "candidate"), null);
  assert.equal(sectionForNotificationLink("https://evil.test", "admin"), null);
});

test("flat honesty_status / publication_stage fields from /api/state are recognised", () => {
  assert.equal(isHonestyRejected(attempt({ honesty_status: "rejected" })), true);
  assert.equal(isHonestyRejected(attempt({ publication_stage: "honesty_rejected" })), true);
  assert.equal(hasAssessmentNotification(attempt({ honesty_status: "rejected", honesty_reason: "x" })), true);
  assert.equal(isHonestyRejected(attempt({ honesty_status: "approved" })), false);
});
