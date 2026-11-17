import { expect, test } from "@playwright/test";

// Browser permission APIs are mocked here: production still requires the
// candidate's own clicks and explicit approval in the browser sharing picker.
async function examWorkspace(page, { attempts = [], denied = false, shortage = false, mobile = false } = {}) {
  const calls = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ denied, mobile }) => {
    localStorage.setItem("sb_token", "exam-setup-test");
    localStorage.setItem("sb_lang", "en");
    if (mobile) Object.defineProperty(navigator, "userAgent", { value: "Android Mobile" });
    let fullscreen = null;
    window.examPermissionCalls = { share: 0, camera: 0, fullscreen: 0, shareActivation: false, fullscreenActivation: false };
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
    // Init scripts run before <html> exists, so install on the prototype.
    Element.prototype.requestFullscreen = async () => {
      window.examPermissionCalls.fullscreen++;
      window.examPermissionCalls.fullscreenActivation = navigator.userActivation.isActive;
      fullscreen = document.documentElement;
      document.dispatchEvent(new Event("fullscreenchange"));
    };
    document.exitFullscreen = async () => {
      fullscreen = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    };
    navigator.mediaDevices.getUserMedia = async () => {
      window.examPermissionCalls.camera++;
      throw new Error("Camera/microphone must not be requested in R0");
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.examPermissionCalls.share++;
      window.examPermissionCalls.shareActivation = navigator.userActivation.isActive;
      if (denied) throw new DOMException("Permission denied", "NotAllowedError");
      const track = new EventTarget();
      track.readyState = "live";
      track.getSettings = () => ({ displaySurface: "monitor" });
      track.stop = () => { track.readyState = "ended"; };
      const stream = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
      window.stopExamShare = () => { track.stop(); track.dispatchEvent(new Event("ended")); };
      return stream;
    };
  }, { denied, mobile });
  const state = { user: { name: "Exam Candidate", email: "exam@example.test" }, from_profile: true, consented: true, has_cv: true, confirmed: ["python"], passports: [], attempts };
  const question = (index) => ({ id: "q-" + index, prompt: "MOCK Fundamental test question " + index, question_type: "MCQ", assessment_topic: "DSA", assessment_section: "fundamental", options: ["MOCK A", "MOCK B"], difficulty_level: "Easy", marks: 1 });
  const allQuestions = Array.from({ length: 40 }, (_, i) => question(i));
  const initial = { attempt_id: "active-exam", kind: "pre", status: "active", mode: "initial_cv_fundamentals", graphrag: true, blueprint_id: "initial-bp", session_id: "synthetic-session-long-enough", last_event_seq: 0, remaining: 2400, duration_seconds: 2400, total: 40, answered: 0, question_index: 0, question: allQuestions[0], all_questions: allQuestions, answers: {}, navigator: allQuestions.map((q, i) => ({ id: q.id, number: i + 1, type: "MCQ", topic: "DSA" })) };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    let body;
    try { body = request.postDataJSON(); } catch { body = null; }
    calls.push({ path, body, method: request.method() });
    const ok = (data) => route.fulfill({ json: data });
    if (path === "/enterprise/me") return ok({ role: "candidate", user: state.user });
    if (path === "/state") return ok(state);
    if (path === "/candidate/profile/status") return ok({ status: "confirmed" });
    if (path === "/job") return ok({ job: { title: "MOCK role", preferred: [] }, gap: [] });
    if (path === "/skill-journey") return ok({ journey: [] });
    if (path === "/assessment/initial-blueprint" || path === "/assessment/blueprint") return ok(shortage
      ? { status: "question_bank_incomplete", shortages: [{ topic: "DSA" }], message: "MOCK bank needs more approved questions." }
      : { status: "ready", blueprint_id: path.includes("initial") ? "initial-bp" : "profile-bp" });
    if (path === "/attempts" && request.method() === "POST") return ok(initial);
    if (path === "/attempts/active-exam/quit") { state.attempts = []; return ok({ status: "quit" }); }
    return ok({ items: [] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Search workspace", exact: true }).click();
  await page.getByRole("textbox", { name: "Search pages" }).fill("journey");
  await page.keyboard.press("Enter");
  if (attempts.some((attempt) => attempt.status === "done")) await page.locator(".steps").getByRole("button", { name: /Profile retake/ }).click();
  return { calls, errors };
}

async function permissions(page) {
  await page.getByRole("button", { name: "Enable screen sharing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Screen sharing active", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Enter full-screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Full-screen mode active", exact: true })).toBeVisible();
}

test("Initial exam starts after exactly two click-triggered browser permissions, without a camera", async ({ page }) => {
  const { calls, errors } = await examWorkspace(page);
  const start = page.getByRole("button", { name: "Start Initial exam · 40 minutes", exact: true });
  await expect(start).toBeDisabled();
  await expect(page.getByRole("button", { name: "Enable camera", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Enable screen sharing", exact: true }).click();
  await expect(start).toBeDisabled();
  await page.getByRole("button", { name: "Enter full-screen", exact: true }).click();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole("heading", { name: "MOCK Fundamental test question 0" })).toBeVisible();
  expect(calls.find((call) => call.path === "/attempts").body).toEqual({ blueprint_id: "initial-bp" });
  expect(calls.filter((call) => call.path === "/assessment/blueprint")).toHaveLength(0);
  const events = calls.filter((call) => call.path.endsWith("/event"));
  expect(events[0].body.type).toBe("screen_share_started");
  expect(await page.evaluate(() => window.examPermissionCalls)).toEqual({ share: 1, camera: 0, fullscreen: 1, shareActivation: true, fullscreenActivation: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Quit assessment", exact: true }).click();
  await expect(page.locator("body")).not.toHaveClass(/exam-live/);
  expect(errors).toEqual([]);
});

test("stopping share or exiting fullscreen disables Start until restored", async ({ page }) => {
  await examWorkspace(page);
  await permissions(page);
  const start = page.getByRole("button", { name: "Start Initial exam · 40 minutes" });
  await expect(start).toBeEnabled();
  await page.evaluate(() => window.stopExamShare());
  await expect(start).toBeDisabled();
  await page.getByRole("button", { name: "Enable screen sharing", exact: true }).click();
  await expect(start).toBeEnabled();
  await page.evaluate(() => document.exitFullscreen());
  await expect(start).toBeDisabled();
  await page.getByRole("button", { name: "Enter full-screen", exact: true }).click();
  await expect(start).toBeEnabled();
});

test("denied sharing gives an actionable message and never starts an attempt", async ({ page }) => {
  const { calls } = await examWorkspace(page, { denied: true });
  await page.getByRole("button", { name: "Enable screen sharing", exact: true }).click();
  await expect(page.getByText(/Screen sharing was cancelled or denied/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Initial exam · 40 minutes" })).toBeDisabled();
  expect(calls.filter((call) => call.path === "/attempts")).toHaveLength(0);
});

test("Profile exam is the retake even after a completed previous retake", async ({ page }) => {
  const { calls, errors } = await examWorkspace(page, { attempts: [
    { id: "first", kind: "pre", status: "done", finalized: true, review_decision: "approved" },
    { id: "previous-retake", kind: "post", status: "done", finalized: true, review_decision: "approved" },
  ] });
  await expect(page.getByRole("heading", { name: "Profile retake exam", exact: true })).toBeVisible();
  await permissions(page);
  await page.getByRole("button", { name: "Start Profile retake exam", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MOCK Fundamental test question 0" })).toBeVisible();
  expect(calls.find((call) => call.path === "/attempts").body).toEqual({ blueprint_id: "profile-bp" });
  expect(calls.filter((call) => call.path === "/assessment/initial-blueprint")).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("resume skips blueprint generation and preserves the saved attempt", async ({ page }) => {
  const { calls } = await examWorkspace(page, { attempts: [{ id: "active-exam", kind: "pre", status: "active" }] });
  await permissions(page);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MOCK Fundamental test question 0" })).toBeVisible();
  expect(calls.find((call) => call.path === "/attempts").body).toEqual({ resume_attempt_id: "active-exam" });
  expect(calls.filter((call) => call.path.startsWith("/assessment/") && call.method === "POST")).toHaveLength(0);
});

test("bank shortages do not silently substitute the old adaptive exam", async ({ page }) => {
  const { calls } = await examWorkspace(page, { shortage: true });
  await permissions(page);
  await page.getByRole("button", { name: "Start Initial exam · 40 minutes" }).click();
  await expect(page.getByText("MOCK bank needs more approved questions.")).toBeVisible();
  expect(calls.filter((call) => call.path === "/attempts")).toHaveLength(0);
});

test("Profile retake shortages also stop instead of substituting another exam", async ({ page }) => {
  const { calls } = await examWorkspace(page, { shortage: true, attempts: [
    { id: "first", kind: "pre", status: "done", finalized: true, review_decision: "approved" },
  ] });
  await permissions(page);
  await page.getByRole("button", { name: "Start Profile retake exam", exact: true }).click();
  await expect(page.getByText("MOCK bank needs more approved questions.")).toBeVisible();
  expect(calls.filter((call) => call.path === "/attempts")).toHaveLength(0);
});

test("mobile user agents cannot begin a desktop-only assessment", async ({ page }) => {
  await examWorkspace(page, { mobile: true });
  await permissions(page);
  await expect(page.getByRole("button", { name: "Start Initial exam · 40 minutes" })).toBeDisabled();
  await expect(page.getByText("✕ Desktop device required", { exact: true })).toBeVisible();
});
