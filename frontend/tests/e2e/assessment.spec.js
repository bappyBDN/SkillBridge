import { expect, test } from "@playwright/test";

const pending = { stage: "evaluation_pending", ready: false, pending_evaluations: 2, academic_status: "pending", honesty_status: "pending", honesty: { score: 87, status: "pending", advisory: true } };
const published = { ...pending, stage: "published", ready: true, pending_evaluations: 0, academic_status: "approved", honesty_status: "approved", honesty: { score: 87, status: "approved", advisory: true } };
const credential = {
  pid: "synthetic-credential", holder: "Sadia Rahman", release_id: "reviewed-release-123456", issued: "2026-11-16", expires: "2027-11-16",
  issuer: "TalentForge Global R0 prototype", honesty: published.honesty, assessment: { overall: 76, review_decision: "approved" },
  skills: [{ skill: "python", name: "Python", score: 50, level: "Intermediate", questions: 5, section: "cv" }, { skill: "sql", name: "SQL", score: 92, level: "Advanced", questions: 5, section: "fundamental" }],
};

async function candidate(page, approved = false) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("sb_token", "assessment-ui-test"); localStorage.setItem("sb_lang", "en"); });
  const publication = approved ? published : pending;
  const objective = { mcq_questions: 10, mcq_score: 100, provisional: true };
  const state = { user: { name: "Sadia Rahman", email: "sadia@example.test" }, consented: true, from_profile: true, confirmed: ["python"], passports: [], attempts: [{ id: "assessment-1", kind: "pre", status: "done", finished: 1763200000, finalized: approved, overall: approved ? 76 : null, publication, objective_summary: objective, topics: {} }] };
  const resource = { id: "course-1", topic: "python", title: "MOCK reviewed Python course", provider: "MOCK Catalogue", language: "en", level: 2, url: "https://example.test/python", estimated_minutes: 30, reason: "Matches your approved Python topic score.", citation_id: "course-1" };
  let advice = null;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const ok = (body) => route.fulfill({ json: body });
    if (path === "/enterprise/me") return ok({ role: "candidate", user: state.user });
    if (path === "/state") return ok(state);
    if (path === "/candidate/profile/status") return ok({ status: "confirmed" });
    if (path === "/learning/dashboard") return ok({ based_on: "assessment-1", approved, publication, result_summary: { overall: approved ? 76 : null, publication, honesty: publication.honesty, objective_summary: objective },
      resources: approved ? [resource] : [], gaps: approved ? ["python"] : [], gap_details: [], performance: [], progress: { started: 0, completed: 0 }, attempt_history: [], release_history: approved ? [{ id: "reviewed-release-123456", created: 1763200000, overall: 76, honesty_score: 87 }] : [],
      learning_plan: approved ? { release_id: "reviewed-release-123456", ai_advice: advice } : null, retake: { balance: 0, credit_cost: 1, max_attempts_90d: 3, attempts_used_90d: 1 } });
    if (path === "/learning/plan/explain") { advice = { provider: "test", model: "test-model", recommendations: [{ resource_id: "course-1", reason: "Practice input validation with the exercises in this reviewed course." }] }; return ok({ status: "available", advice }); }
    return ok({ items: [] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Search workspace", exact: true }).click();
  await page.getByRole("textbox", { name: "Search pages" }).fill("Learning");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Turn skill gaps into progress." })).toBeVisible();
  return errors;
}

test("incomplete results show MCQ-only feedback, both approval gates and no courses", async ({ page }, testInfo) => {
  const errors = await candidate(page);
  await expect(page.getByRole("region", { name: "Assessment review progress" })).toContainText("100%");
  await expect(page.getByText("Your personalized plan is awaiting both approvals.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open resource" })).toHaveCount(0);
  await expect(page.getByText("Your current skill gaps are covered.")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("pending-assessment-learning.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("published learning shows retrieved course citations, saved revisions and optional AI explanations", async ({ page }, testInfo) => {
  const errors = await candidate(page, true);
  await expect(page.getByText("MOCK reviewed Python course", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Published result revisions" })).toBeVisible();
  await page.getByRole("button", { name: "Explain my study plan with AI" }).click();
  await expect(page.getByRole("heading", { name: "Source-grounded study guidance" })).toBeVisible();
  await expect(page.getByRole("link", { name: "[Source course-1]", exact: true })).toHaveAttribute("href", "https://example.test/python");
  await page.screenshot({ path: testInfo.outputPath("approved-learning-plan.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("public skill passport presents approved topic percentages and a separate honesty score", async ({ page }, testInfo) => {
  await page.route("**/api/public/passport/synthetic-credential", (route) => route.fulfill({ json: { revoked: false, expired: false, signature_valid: true, passport: credential } }));
  await page.goto("/#/p/synthetic-credential");
  await expect(page.getByRole("heading", { name: "Sadia Rahman", exact: true })).toBeVisible();
  await page.getByRole("cell", { name: "50%" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("cell", { name: "50%" })).toBeInViewport();
  expect(await page.locator(".credential-table-wrap").evaluate((table) => table.scrollLeft)).toBe(0);
  await expect(page.getByText("HONESTY REVIEW", { exact: true })).toBeVisible();
  await expect(page.getByText("87", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Print / save PDF" })).toBeVisible();
  expect(await page.getByRole("button", { name: "Print / save PDF" }).evaluate((button) => getComputedStyle(button).backgroundColor)).toBe("rgb(18, 117, 103)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("skill-passport.png"), fullPage: true });
});

test("withdrawn credentials cannot display the old scores", async ({ page }) => {
  await page.route("**/api/public/passport/synthetic-credential", (route) => route.fulfill({ json: { revoked: true, review_required: true, signature_valid: true } }));
  await page.goto("/#/p/synthetic-credential");
  await expect(page.locator(".note")).toBeVisible();
  await expect(page.locator(".skill-credential")).toHaveCount(0);
});
