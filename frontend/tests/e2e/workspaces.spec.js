import { expect, test } from "@playwright/test";

// Synthetic API fixtures exercise browser interactions independently of any
// deployment. Real invitation authorization is covered by backend integration tests.
async function workspace(page, role, { onboarding = false, teamError = false, cvError = false } = {}) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("sb_token", "browser-test-token"); localStorage.setItem("sb_lang", "en"); });
  const state = {
    user: { name: "Sadia Rahman", email: "sadia@example.test" }, consented: true, from_profile: true,
    has_cv: true, confirmed: ["sql", "python"], passports: [],
    attempts: [
      { id: "new", kind: "post", status: "done", overall: 86, review_decision: "approved", finished: 1763200000 },
      { id: "old", kind: "pre", status: "done", overall: 64, review_decision: "approved", finished: 1763000000 },
    ],
  };
  let joined = !onboarding;
  let members = [{ id: "member-1", email: "colleague@example.test", company_role: "recruiter", status: "active" }];
  let applied = false;
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    calls.push({ path, method: request.method(), headers: request.headers(), body: request.postDataJSON() });
    const ok = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === "/enterprise/me") return ok({ role, user: state.user });
    if (path === "/state") return ok(state);
    if (path === "/candidate/profile/status") return ok({ status: "confirmed" });
    if (path === "/candidate/profile") return ok({ profile: { ...state.user, headline: "Data analyst", skills: [{ name: "SQL" }, { name: "Python" }], education: [], experience: [], projects: [], certifications: [], achievements: [], languages: [], references: [], volunteer: [], preferences: { job_types: [], locations: [] } }, completeness: { total: 60, sections: {} } });
    if (path === "/jobs") return ok({ items: [{ id: "job-1", title: "Junior Data Analyst", company_name: "MOCK Northstar", description: "Analyze product data using SQL and Python.", location: "Remote", employment_type: "Full-time", skills: ["SQL", "Python"], is_mock: true }] });
    if (path === "/jobs/job-1/apply") { applied = true; return ok({ status: "submitted" }); }
    if (path === "/applications/mine") return ok({ items: applied ? [{ id: "application-1", job_id: "job-1", job_title: "Junior Data Analyst", company_name: "MOCK Northstar", status: "submitted", results_shared: false }] : [] });
    if (path === "/company/workspace") {
      if (!joined) return ok({ detail: "Your account is not connected to an organisation yet" }, 409);
      return ok({ company: { id: "company-1", name: "Northstar Technologies", website: "https://example.test", verified: true, role: "owner" }, verification: { status: "verified" }, permissions: { manage_team: true, manage_jobs: true, manage_pipeline: true, view_reports: true }, job_eligibility: { can_create_draft: true, can_publish: true } });
    }
    if (path === "/company/jobs") return ok({ items: [] });
    if (path === "/company/applications") return ok({ items: [{ application_id: "application-1", candidate_name: "Sadia Rahman", job_title: "Data Analyst", status: "submitted", results_shared: false }] });
    if (path === "/company/analytics") return ok({ totals: { jobs: 0, published_jobs: 0, applicants: 1, shared_results: 0 }, stages: [{ status: "submitted", n: 1 }], jobs: [] });
    if (path === "/company/team") return teamError ? ok({ detail: "Team service unavailable" }, 503) : ok({ items: members });
    if (path === "/company/team/invitations") {
      const body = request.postDataJSON();
      members = [...members.filter((m) => m.email !== body.email), { id: "member-2", email: body.email, company_role: body.role, status: "invited" }];
      return ok({ invite_token: "synthetic-secure-token", message: "Invitation ready. No invitation email was sent." });
    }
    if (path.startsWith("/company/team/accept/")) { joined = true; return ok({ status: "active" }); }
    if (path.startsWith("/company/team/") && request.method() === "PATCH") {
      const body = request.postDataJSON();
      members = members.map((member) => path.endsWith("/" + member.id) ? (body.role === "revoked" ? { ...member, status: "revoked" } : { ...member, company_role: body.role }) : member);
      return ok({ role: body.role });
    }
    if (path === "/company/invitations") return ok({ items: [{ id: "invite-1", company_name: "Northstar Technologies", company_role: "recruiter", invite_token: "synthetic-invite" }] });
    if (path === "/company/applications/application-1") return ok({ application_id: "application-1", candidate_name: "Sadia Rahman", job_title: "Data Analyst", status: "submitted", candidate_cv: { available: true, filename: "sadia-cv.pdf", url: "/api/company/applications/application-1/cv" }, candidate_skills: [], required_skills: [], assessment_history: [], notes: [], history: [] });
    if (path.endsWith("/cv")) {
      if (cvError) return ok({ detail: "CV temporarily unavailable" }, 503);
      return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF" });
    }
    if (path === "/admin/console/me") return ok({ admin_role: "super_admin" });
    if (path === "/admin/console/overview") return ok({ counts: { users: 1, candidates: 1, companies: 0 }, queues: [] });
    if (path === "/admin/console/users") return ok({ items: [{ id: 42, ...state.user, role: "candidate", created: 1763200000 }] });
    if (path === "/admin/candidates/42") return ok({ user: state.user, profile: { skills: [] }, attempts: [], passports: [], applications: [], cv: { has_pdf: true, filename: "sadia-cv.pdf", pdf_url: "/api/admin/candidates/42/cv", documents: [] } });
    return ok({ items: [] });
  });
  await page.goto("/");
  return { errors, calls };
}

async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test("candidate search, latest result, notifications and mobile navigation work", async ({ page }, testInfo) => {
  const { errors } = await workspace(page, "candidate");
  await expect(page.getByRole("heading", { name: "Career overview" })).toBeVisible();
  await expect(page.getByText("Latest score: 86%")).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("candidate-overview.png"), fullPage: true });
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByRole("region", { name: "Assessment notifications" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Search pages" }).fill("jobs");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Find jobs" })).toBeVisible();
  await page.getByRole("button", { name: /Apply/, exact: false }).first().click();
  await expect(page.getByText("Application submitted.")).toBeVisible();
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("candidate profile and application pages stay usable at both viewport sizes", async ({ page }, testInfo) => {
  const { errors } = await workspace(page, "candidate");
  await page.getByRole("button", { name: "Search workspace", exact: true }).click();
  await page.getByRole("textbox", { name: "Search pages" }).fill("profile");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Sadia Rahman", exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("candidate-profile.png"), fullPage: true });
  await page.getByRole("button", { name: "Search workspace", exact: true }).click();
  await page.getByRole("textbox", { name: "Search pages" }).fill("does-not-exist");
  await expect(page.getByText("No pages found. Try a different search.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("company team invitations, role assignment and revocation work", async ({ page }, testInfo) => {
  const { errors, calls } = await workspace(page, "company");
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Team members" })).toBeVisible();
  await page.getByRole("combobox", { name: "Role for colleague@example.test" }).selectOption("hiring_manager");
  await expect(page.getByText("Team permissions updated.")).toBeVisible();
  await page.getByLabel("Email address", { exact: true }).fill("new@example.test");
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByText("synthetic-secure-token", { exact: true })).toBeVisible();
  await expect(page.getByText("new@example.test", { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("company-team.png"), fullPage: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("combobox", { name: "Role for colleague@example.test" }).selectOption("revoked");
  await expect(page.getByRole("button", { name: "Re-invite" })).toBeVisible();
  expect(calls.some((call) => call.method === "PATCH" && call.body.role === "hiring_manager")).toBe(true);
  expect(errors).toEqual([]);
});

test("invited company accounts can discover and join their team without creating a company", async ({ page }) => {
  const { errors, calls } = await workspace(page, "company", { onboarding: true });
  await expect(page.getByText("Northstar Technologies", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Join team", exact: true }).click();
  await expect(page.locator(".cr-org strong")).toHaveText("Northstar Technologies");
  expect(calls.some((call) => call.path === "/company/team/accept/synthetic-invite")).toBe(true);
  expect(calls.some((call) => call.path === "/company/profile" && call.method === "POST")).toBe(false);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("company team service failures are visible instead of showing an empty team", async ({ page }) => {
  await workspace(page, "company", { teamError: true });
  await expect(page.getByRole("alert")).toContainText("Team service unavailable");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("admin CV preview uses an authenticated URL exactly once and supports download", async ({ page }, testInfo) => {
  const { errors, calls } = await workspace(page, "admin");
  await page.getByRole("button", { name: "Users & accounts", exact: true }).click();
  await page.getByRole("button", { name: "View candidate", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sadia Rahman" });
  await expect(dialog.locator("iframe")).toHaveAttribute("src", /^blob:/);
  const request = calls.find((call) => call.path === "/admin/candidates/42/cv");
  expect(request?.headers.authorization).toBe("Bearer browser-test-token");
  expect(calls.some((call) => call.path.startsWith("/api/"))).toBe(false);
  const download = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Download PDF" }).click();
  expect((await download).suggestedFilename()).toBe("sadia-cv.pdf");
  await page.screenshot({ path: testInfo.outputPath("admin-cv-preview.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("company applicant CV also previews through the protected endpoint", async ({ page }) => {
  const { errors, calls } = await workspace(page, "company");
  await page.locator(".cr-applicant-row").first().click();
  await expect(page.getByTitle("CV preview: sadia-cv.pdf")).toHaveAttribute("src", /^blob:/);
  expect(calls.some((call) => call.path === "/company/applications/application-1/cv")).toBe(true);
  expect(errors).toEqual([]);
});

test("failed admin CV load displays an actionable error", async ({ page }) => {
  await workspace(page, "admin", { cvError: true });
  await page.getByRole("button", { name: "Users & accounts", exact: true }).click();
  await page.getByRole("button", { name: "View candidate", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("CV temporarily unavailable");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
});

test("admin can edit draft marks and approve academics without prematurely publishing", async ({ page }) => {
  const { errors } = await workspace(page, "admin");
  const evaluation = { question_id: "explain-1", status: "pending_approval", max_marks: 2, ai_marks: 1, confidence: 0.6, method: "stored-rubric", components: {}, keywords: {}, flags: [], rationale: "Reference evidence requires human review." };
  const report = { id: "review-1", candidate_name: "Sadia Rahman", email: "sadia@example.test", kind: "pre", result: { overall: 50, topics: { python: { score: 50, level: "Intermediate", n: 1 } } },
    publication: { stage: "evaluation_pending", ready: false, pending_evaluations: 1, academic_status: "pending", honesty_status: "pending" },
    evaluation_summary: { pending_admin_approval: 1 }, evaluations: [evaluation], answer_evidence_complete: true,
    answer_evidence: [{ number: 1, question_id: "explain-1", question: "Explain input validation.", topic: "Python", type: "Explanation", candidate_answer: "Validate input types.", max_marks: 2, evaluation }] };
  let savedMark = null;
  let approved = null;
  await page.route("**/api/admin/assessment-reviews", (route) => route.fulfill({ json: { items: [report] } }));
  await page.route("**/api/admin/attempts/review-1/evaluations/explain-1", (route) => {
    savedMark = route.request().postDataJSON();
    Object.assign(evaluation, savedMark, { final_marks: savedMark.marks });
    report.result.overall = 75;
    return route.fulfill({ json: evaluation });
  });
  await page.route("**/api/admin/attempts/review-1/review", (route) => {
    approved = route.request().postDataJSON();
    return route.fulfill({ json: { decision: "approved", publication: { stage: "honesty_review", ready: false }, passport_id: null, learning_path_updated: false } });
  });
  await page.reload();
  await page.getByRole("button", { name: "Assessment reviews", exact: true }).click();
  await page.getByRole("button", { name: "View report", exact: true }).click();
  const modal = page.locator(".ad-report-modal");
  await modal.getByLabel(/Approved marks/).fill("1.5");
  await modal.getByLabel("Administrator note (reason for the mark)").fill("Human reviewed partial credit.");
  await modal.getByRole("button", { name: "Save & approve this mark", exact: true }).click();
  await expect.poll(() => savedMark?.marks).toBe(1.5);
  await modal.getByRole("button", { name: "Approve academic marks", exact: true }).click();
  await page.getByLabel("Decision reason").fill("All academic evidence reviewed and approved.");
  await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
  await expect.poll(() => approved?.evaluations?.[0]?.marks).toBe(1.5);
  await expect(page.getByText("Academic marks approved. Learning and the passport remain locked until honesty approval.")).toBeVisible();
  expect(errors).toEqual([]);
});
