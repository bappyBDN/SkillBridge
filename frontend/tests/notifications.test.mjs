import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessmentNotificationItems,
  hasAssessmentNotification,
  isPublishedAttempt,
  notificationTimestamp,
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

test("the newest three are the only ones surfaced by the panel slice", () => {
  const attempts = [1, 2, 3, 4].map((n) => attempt({ id: `n${n}`, finalized: true, finished: n * 100 }));
  const items = assessmentNotificationItems(attempts);
  assert.deepEqual(items.slice(0, 3).map((item) => item.id), ["n4", "n3", "n2"]);
});
