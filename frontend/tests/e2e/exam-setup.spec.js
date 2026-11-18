import { expect, test } from "@playwright/test";

// Browser permission APIs are mocked here: production still requires the
// candidate's own clicks and explicit approval in the browser sharing picker.
async function examWorkspace(page, { attempts = [], denied = false, shortage = false, mobile = false, r1 = false, cameraDenied = false, micDenied = false } = {}) {
  const calls = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ denied, mobile, r1, cameraDenied, micDenied }) => {
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
    const streamOf = (kind) => {
      const track = new EventTarget();
      track.kind = kind;
      track.readyState = "live";
      track.muted = false;
      track.stop = () => { track.readyState = "ended"; };
      const stream = { getTracks: () => [track], getVideoTracks: () => kind === "video" ? [track] : [], getAudioTracks: () => kind === "audio" ? [track] : [] };
      if (kind === "video") window.stopR1Camera = () => { track.stop(); track.dispatchEvent(new Event("ended")); };
      return stream;
    };
    if (r1) {
      // Synthetic media/model fixtures verify workflow, not real AI accuracy.
      window.examPermissionCalls.microphone = 0;
      const streams = new WeakMap();
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, get() { return streams.get(this); }, set(value) { streams.set(this, value); } });
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { configurable: true, get: () => performance.now() / 1000 });
      Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 640 });
      Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 480 });
      HTMLMediaElement.prototype.play = async () => {};
      HTMLMediaElement.prototype.pause = () => {};
      CanvasRenderingContext2D.prototype.drawImage = () => {};
      window.AudioContext = class extends EventTarget {
        constructor() { super(); this.state = "running"; }
        async resume() { this.state = "running"; this.dispatchEvent(new Event("statechange")); }
        async close() { this.state = "closed"; this.dispatchEvent(new Event("statechange")); }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(data) { data.fill(window.mockSoundLevel || 0); } }; }
      };
    }
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints.video) window.examPermissionCalls.camera++;
      else window.examPermissionCalls.microphone++;
      if (!r1) throw new Error("Camera/microphone must not be requested in R0");
      if ((constraints.video && cameraDenied) || (constraints.audio && micDenied)) throw new DOMException("MOCK permission denied", "NotAllowedError");
      return streamOf(constraints.video ? "video" : "audio");
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
  }, { denied, mobile, r1, cameraDenied, micDenied });
  const proctoring = { mode: "r1", consent_version: "r1-proctoring-v1", required: ["screen", "fullscreen", "camera", "microphone"], retention_days: 30, max_snapshots: 40 };
  if (r1) await page.route("**/*mediapipe*tasks-vision*", (route) => route.fulfill({ contentType: "application/javascript", body: `
    export class FilesetResolver { static async forVisionTasks() { return {}; } }
    export class FaceLandmarker { static async createFromOptions() { return { detectForVideo() { return { faceLandmarks: Array.from({length: window.mockFaces ?? 1}, () => []) }; }, close() {} }; } }
    export class ObjectDetector { static async createFromOptions() { return { detectForVideo() { return { detections: window.mockPhone ? [{ categories: [{ categoryName: "cell phone", score: 0.88 }] }] : [] }; }, close() {} }; } }
  ` }));
  const state = { user: { name: "Exam Candidate", email: "exam@example.test" }, from_profile: true, consented: true, has_cv: true, confirmed: ["python"], passports: [], attempts,
    ...(r1 ? { proctoring_policy: proctoring } : {}) };
  const question = (index) => ({ id: "q-" + index, prompt: "MOCK Fundamental test question " + index, question_type: "MCQ", assessment_topic: "DSA", assessment_section: "fundamental", options: ["MOCK A", "MOCK B"], difficulty_level: "Easy", marks: 1 });
  const allQuestions = Array.from({ length: 40 }, (_, i) => question(i));
  const initial = { attempt_id: "active-exam", kind: "pre", status: "active", mode: "initial_cv_fundamentals", graphrag: true, blueprint_id: "initial-bp", session_id: "synthetic-session-long-enough", last_event_seq: 0, remaining: 2400, duration_seconds: 2400, total: 40, answered: 0, question_index: 0, question: allQuestions[0], all_questions: allQuestions, answers: {}, navigator: allQuestions.map((q, i) => ({ id: q.id, number: i + 1, type: "MCQ", topic: "DSA" })) };
  if (r1) initial.proctoring = proctoring;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    let body;
    try { body = request.postDataJSON(); } catch { body = null; }
    calls.push({ path, body, method: request.method(), ...(path.endsWith("/evidence") ? { form: request.postData() } : {}) });
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
    if (path.endsWith("/evidence")) return ok({ ok: true, evidence_id: "MOCK-snapshot" });
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

async function r1Permissions(page) {
  await page.getByLabel(/I consent to this R1 monitoring/).check();
  await page.getByRole("button", { name: "Enable camera", exact: true }).click();
  await expect(page.getByRole("button", { name: "Camera active", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Enable microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Microphone active", exact: true })).toBeVisible();
  await page.getByLabel(/If the comparison is unavailable/).check();
  await permissions(page);
}

test("R1 requires explicit consent, all four devices and an identity-review outcome", async ({ page }) => {
  const { calls, errors } = await examWorkspace(page, { r1: true });
  await expect(page.getByRole("button", { name: "Enable camera", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Enable microphone", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start Initial exam · 40 minutes" })).toBeDisabled();
  await r1Permissions(page);
  await page.getByRole("button", { name: "Start Initial exam · 40 minutes" }).click();
  await expect(page.getByRole("heading", { name: "MOCK Fundamental test question 0" })).toBeVisible();
  const request = calls.find((call) => call.path === "/attempts");
  expect(request.body.proctoring_ready).toEqual({ screen: true, fullscreen: true, camera: true, microphone: true });
  expect(request.body.proctoring_consent).toBe("r1-proctoring-v1");
  expect(request.body.identity_status).toBe("needs_review");
  await expect(page.getByText("Local AI monitoring active", { exact: true })).toBeVisible();
  await page.evaluate(() => window.stopR1Camera());
  await expect(page.getByText(/Assessment controls are paused/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit assessment", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Quit assessment", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("R1 sound and camera observations produce linked camera/screen evidence uploads", async ({ page }) => {
  const { calls, errors } = await examWorkspace(page, { r1: true });
  await r1Permissions(page);
  await page.getByRole("button", { name: "Start Initial exam · 40 minutes" }).click();
  await expect(page.getByText("Local AI monitoring active", { exact: true })).toBeVisible();
  await page.evaluate(() => { window.mockSoundLevel = .12; window.mockFaces = 0; window.mockPhone = true; });
  for (const type of ["ai_audio_level", "ai_no_face", "ai_phone_detected"]) {
    await expect.poll(() => calls.some((call) => call.path.endsWith("/event") && call.body?.type === type)).toBe(true);
    await expect.poll(() => calls.filter((call) => call.path.endsWith("/evidence") && call.form.includes(`\r\n\r\n${type}\r\n`)).length).toBe(2);
  }
  expect(calls.some((call) => call.path.endsWith("/evidence") && call.form.includes("\r\n\r\nscreen\r\n"))).toBe(true);
  expect(errors).toEqual([]);
});

test("denying a mandatory R1 microphone blocks start without opening an attempt", async ({ page }) => {
  const { calls } = await examWorkspace(page, { r1: true, micDenied: true });
  await page.getByLabel(/I consent to this R1 monitoring/).check();
  await page.getByRole("button", { name: "Enable microphone", exact: true }).click();
  await expect(page.getByText(/Microphone access was denied/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Initial exam · 40 minutes" })).toBeDisabled();
  expect(calls.some((call) => call.path === "/attempts")).toBe(false);
});

test("leaving full-screen locks the exam behind an overlay and paste is blocked and recorded", async ({ page }) => {
  const { calls, errors } = await examWorkspace(page);
  await permissions(page);
  await page.getByRole("button", { name: "Start Initial exam · 40 minutes" }).click();
  await expect(page.getByRole("heading", { name: "MOCK Fundamental test question 0" })).toBeVisible();
  await page.evaluate(() => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
  });
  await expect.poll(() => calls.some((call) => call.path.endsWith("/event") && call.body?.type === "paste")).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "You left full-screen" })).toBeVisible();
  await page.getByRole("button", { name: "Return to full-screen exam" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
