import assert from "node:assert/strict";
import { test } from "node:test";
import { api, apiUrl } from "../src/api.js";

test("API paths are prefixed exactly once, including server CV URLs", () => {
  assert.equal(apiUrl("/state"), "/api/state");
  assert.equal(apiUrl("/api/admin/candidates/42/cv"), "/api/admin/candidates/42/cv");
  assert.equal(apiUrl("/admin/candidates/42/cv?document_id=abc"), "/api/admin/candidates/42/cv?document_id=abc");
});

test("API client refuses external and protocol-relative URLs before attaching credentials", () => {
  for (const path of ["https://external.test/cv", "//external.test/cv", "/\\external.test", undefined]) {
    assert.throws(() => apiUrl(path), /Invalid API path/);
  }
});

test("caller headers are sent but cannot replace the bearer token", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: () => "test-token" };
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = options.headers;
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    await api("/attempts/a1/answer", { method: "POST", body: { answer: "x" }, headers: { "X-Exam-Session": "session-1", Authorization: "Bearer attacker" } });
    assert.equal(sent["X-Exam-Session"], "session-1");
    assert.equal(sent.Authorization, "Bearer test-token");
    assert.equal(sent["Content-Type"], "application/json");
  } finally { globalThis.fetch = previousFetch; delete globalThis.localStorage; }
});

test("authenticated CV fetch preserves binary PDF data", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: () => "test-token" };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/admin/candidates/42/cv");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    return new Response("%PDF-1.4 test", { headers: { "Content-Type": "application/pdf" } });
  };
  try {
    const pdf = await api("/api/admin/candidates/42/cv", { responseType: "blob" });
    assert.equal(await pdf.text(), "%PDF-1.4 test");
  } finally { globalThis.fetch = previousFetch; delete globalThis.localStorage; }
});

/* ---------- exit beacon uses the configured API base ---------- */
import { apiUrl as buildApiUrl, isCrossOriginApi, sendExitBeacon } from "../src/api.js";

test("apiUrl honours an explicit base (VITE_API_BASE_URL split deploys)", () => {
  assert.equal(buildApiUrl("/attempts/a1/event/beacon", "https://api.example.test"), "https://api.example.test/api/attempts/a1/event/beacon");
});

test("cross-origin detection", () => {
  assert.equal(isCrossOriginApi("", "https://app.example.test"), false);
  assert.equal(isCrossOriginApi("https://app.example.test", "https://app.example.test"), false);
  assert.equal(isCrossOriginApi("https://api.example.test", "https://app.example.test"), true);
});

test("same-origin exit events use sendBeacon with the token in the body", () => {
  const calls = [];
  const navigatorImpl = { sendBeacon: (url, blob) => { calls.push({ url, type: blob.type }); return true; } };
  const result = sendExitBeacon("/attempts/a1/event/beacon", { type: "blur", authorization: "tok" }, {
    base: "", origin: "https://app.example.test", navigatorImpl, fetchImpl: () => { throw new Error("no fetch"); },
  });
  assert.equal(result, "beacon");
  assert.deepEqual(calls, [{ url: "/api/attempts/a1/event/beacon", type: "application/json" }]);
});

test("cross-origin exit events use keepalive fetch to the API host", () => {
  let sent;
  const result = sendExitBeacon("/attempts/a1/event/beacon", { type: "blur", authorization: "tok" }, {
    base: "https://api.example.test", origin: "https://app.example.test",
    navigatorImpl: { sendBeacon: () => { throw new Error("must not beacon cross-origin"); } },
    fetchImpl: (url, options) => { sent = { url, options }; return Promise.resolve(); },
  });
  assert.equal(result, "fetch");
  assert.equal(sent.url, "https://api.example.test/api/attempts/a1/event/beacon");
  assert.equal(sent.options.keepalive, true);
  assert.equal(JSON.parse(sent.options.body).authorization, "tok");
  assert.equal(sent.options.headers.Authorization, undefined);
});

test("a refused beacon falls back to keepalive fetch; invalid paths send nothing", () => {
  let fetched = false;
  const result = sendExitBeacon("/attempts/a1/event/beacon", {}, {
    base: "", origin: "https://app.example.test",
    navigatorImpl: { sendBeacon: () => false },
    fetchImpl: () => { fetched = true; return Promise.reject(new Error("offline")); },
  });
  assert.equal(result, "fetch");
  assert.equal(fetched, true);
  assert.equal(sendExitBeacon("https://evil.test/x", {}, { base: "" }), "failed");
});

/* ---------- error codes are never shown raw ---------- */
import { describeError, errorCode } from "../src/errors.js";
import { DICT } from "../src/i18n.js";

const lookup = (lang) => (key) => DICT[lang][key] ?? DICT.en[key] ?? key;

test("known codes are translated from err.code or a bare message", () => {
  const en = lookup("en");
  assert.equal(describeError({ code: "attempt_not_active", message: "attempt_not_active" }, en).text, DICT.en.attempt_not_active);
  assert.equal(describeError(new Error("screen_share_required"), en).text, DICT.en.screen_share_required);
  assert.equal(describeError(new Error("screen_share_required"), en).code, null);
});

test("monitoring_restore_required:* uses the specific or the prefix rule", () => {
  const en = lookup("en");
  assert.equal(describeError({ code: "monitoring_restore_required:camera_started" }, en).text, DICT.en["monitoring_restore_required:camera_started"]);
  assert.equal(describeError({ code: "monitoring_restore_required:something_new" }, en).text, DICT.en["monitoring_restore_required:*"]);
});

test("unknown codes show a friendly message plus the code, never the code alone", () => {
  const info = describeError({ code: "brand_new_code" }, lookup("bn"));
  assert.equal(info.text, DICT.bn.errorGeneric);
  assert.equal(info.code, "brand_new_code");
  assert.notEqual(info.text, "brand_new_code");
});

test("human sentences pass through; empty errors get the generic text", () => {
  const en = lookup("en");
  assert.equal(describeError(new Error("Question is not part of this assessment"), en).text, "Question is not part of this assessment");
  assert.equal(describeError({}, en).text, DICT.en.errorGeneric);
  assert.equal(describeError(null, en), null);
  assert.equal(errorCode("Not a code"), null);
});

const BACKEND_CODES = [
  "result_awaiting_review", "result_awaiting_honesty_review", "retake_credit_required", "active_attempt_exists",
  "assessment_blueprint_required", "email_not_verified", "screen_share_required", "fullscreen_required",
  "entire_screen_required", "attempt_not_active", "attempt_finished", "monitoring_restore_required:*",
  "account_suspended", "appeal_already_submitted", "appeal_only_available_for_invalidated_results",
  "artifact_not_found", "artifact_not_pending", "attempt_cap", "attempt_not_finished", "attempt_not_found",
  "camera_microphone_screen_fullscreen_required", "consent_required", "cooldown", "draft_not_found",
  "draft_not_pending", "event_rate_limited", "event_sequence_gap", "event_sequence_replayed",
  "evidence_already_saved", "evidence_consent_required", "evidence_limit_reached", "evidence_not_found",
  "evidence_too_large", "exam_session_replaced", "identity_check_or_manual_review_acknowledgement_required",
  "invalid_confidence", "invalid_jpeg", "invalid_status", "jpeg_evidence_required",
  "learning_requires_academic_and_honesty_approval", "mfa_enrollment_required", "mfa_required",
  "mfa_required_for_role", "proctoring_consent_required", "save_the_linked_proctoring_event_first",
  "unsupported_event_type", "unsupported_evidence_event", "unsupported_intent_for_role",
  "blueprint_contains_seen_questions", "database_busy", "review_response_already_submitted",
  "review_response_not_requested", "review_response_too_short",
  "monitoring_restore_required:screen_share_started", "monitoring_restore_required:fullscreen_enter",
  "monitoring_restore_required:camera_started", "monitoring_restore_required:microphone_started",
];

test("every backend error code has English and Bangla text", () => {
  for (const code of BACKEND_CODES) {
    assert.equal(typeof DICT.en[code], "string", `en ${code}`);
    assert.equal(typeof DICT.bn[code], "string", `bn ${code}`);
    assert.notEqual(DICT.bn[code], DICT.en[code], `bn ${code} must be translated`);
  }
});

test("new UI strings have Bangla translations and no hard-coded attempt cap", () => {
  const keys = [
    "errorGeneric", "cancel", "retry", "timeUpTitle", "timeUpSubmitting", "timeUpFailed", "timeUpRetry",
    "exportBusy", "exportReady", "deleteConfirmBtn", "deleteBusy", "assessmentReview_honesty_rejected",
    "honestyRejectedTitle", "honestyRejectedBody", "reviewResponseActionNeeded", "reviewResponseLabel",
    "reviewResponseHelp", "reviewResponseSend", "reviewResponseSent", "notificationsTitle", "notificationsEmpty",
    "notificationsLoadFailed", "withdrawApplication", "withdrawConfirmTitle", "withdrawConfirmBody", "withdrawDone",
    "invitesTitle", "invitesEmpty", "inviteAccept", "inviteDecline", "inviteStatus_approved", "inviteStatus_accepted",
    "inviteStatus_declined", "review_response_unavailable", "withdraw_unavailable",
  ];
  for (const key of keys) {
    assert.equal(typeof DICT.en[key], "string", `en ${key}`);
    assert.notEqual(DICT.bn[key], DICT.en[key], `bn ${key}`);
  }
  assert.doesNotMatch(DICT.en.attempt_cap, /\b3\b/);
  assert.doesNotMatch(DICT.bn.attempt_cap, /৩ বার/);
});

/* ---------- applications and phase-two invitations ---------- */
import { canRespondToInvite, canWithdrawApplication, inviteDeadlinePassed, normalizeInvites } from "../src/applications.js";

test("only non-terminal applications can be withdrawn", () => {
  for (const status of ["submitted", "in_review", "phase_two_invited", "human_interview", "offer"]) {
    assert.equal(canWithdrawApplication({ status }), true, status);
  }
  for (const status of ["withdrawn", "hired", "rejected", "closed", "offer_declined", "", undefined]) {
    assert.equal(canWithdrawApplication({ status }), false, String(status));
  }
});

test("invites can be answered only while awaiting a response and before the deadline", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  assert.equal(canRespondToInvite({ status: "approved", deadline: "" }, now), true);
  assert.equal(canRespondToInvite({ status: "approved", deadline: "2026-11-23" }, now), true, "date-only lasts all day");
  assert.equal(canRespondToInvite({ status: "approved", deadline: "2026-11-01" }, now), false);
  assert.equal(inviteDeadlinePassed({ deadline: "next friday" }, now), false, "free text never blocks");
  assert.equal(canRespondToInvite({ status: "accepted" }, now), false);
  assert.equal(canRespondToInvite({ status: "declined" }, now), false);
  assert.deepEqual(normalizeInvites({ items: [{ id: 3 }, null, {}] }).map((item) => item.id), ["3"]);
  assert.deepEqual(normalizeInvites(undefined), []);
});

/* ---------- project details survive load/edit/save ---------- */
import { normalizeProject, projectsForSave, splitTechnologies } from "../src/profileFields.js";

test("project description, technologies and dates are kept", () => {
  const project = normalizeProject({ name: "Sales dashboard", project_url: "github.com/x", description: "Power BI", technologies: "SQL, Python", start_date: "2025-01", end_date: "2025-03", extra: 1 });
  assert.equal(project.url, "github.com/x");
  assert.deepEqual(project.technologies, ["SQL", "Python"]);
  assert.equal(project.description, "Power BI");
  assert.equal(project.start_date, "2025-01");
  assert.equal(project.extra, 1);
  assert.equal("project_url" in project, false);
  const [saved] = projectsForSave([{ name: " A ", technologies: ["SQL", " ", "Git "], description: " d " }]);
  assert.deepEqual(saved.technologies, ["SQL", "Git"]);
  assert.equal(saved.name, "A");
  assert.equal(saved.description, "d");
  assert.deepEqual(splitTechnologies("SQL, ", { keepEmpty: true }), ["SQL", ""], "typing a comma is not swallowed");
});
