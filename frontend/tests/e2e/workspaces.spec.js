import { expect, test } from "@playwright/test";

// Synthetic API fixtures exercise browser interactions independently of any
// deployment. Real invitation authorization is covered by backend integration tests.
async function workspace(page, role, {
  onboarding = false, teamError = false, cvError = false, passports = [], appeals = [], staff = [],
  identityReviews = [], cvIdentity = null, fromProfile = true, hasCv = true,
  attempts = [
    { id: "new", kind: "post", status: "done", overall: 86, review_decision: "approved", finalized: true, finished: 1763200000 },
    { id: "old", kind: "pre", status: "done", overall: 64, review_decision: "approved", finalized: true, finished: 1763000000 },
    { id: "waiting", kind: "pre", status: "done", overall: null, review_decision: null, finalized: false, finished: 1763100000 },
    { id: "unfinished", kind: "pre", status: "active", overall: null, review_decision: null, finalized: false, started: 1763300000 },
  ],
} = {}) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("sb_token", "browser-test-token"); localStorage.setItem("sb_lang", "en"); });
  const state = {
    user: { name: "Sadia Rahman", email: "sadia@example.test" }, consented: true, from_profile: fromProfile,
    has_cv: hasCv, confirmed: ["sql", "python"], passports, attempts,
  };
  let joined = !onboarding;
  let members = [{ id: "member-1", email: "colleague@example.test", company_role: "recruiter", status: "active" }];
  let staffItems = staff;
  let identityItems = identityReviews;
  let applied = false;
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    let body = null;
    try { body = request.postDataJSON(); } catch { body = null; }
    calls.push({ path, method: request.method(), headers: request.headers(), body });
    const ok = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === "/enterprise/me") return ok({ role, user: state.user });
    if (path === "/state") return ok(state);
    if (path === "/candidate/profile/status") return ok({ status: "confirmed" });
    if (path === "/cv") return ok({
      redacted_preview: "[NAME]\nSkills: SQL",
      redaction: { name: 1 },
      skills: [{ id: "sql", evidence: "SQL project work" }],
      source: "rules",
      identity: cvIdentity,
      taxonomy: [{ id: "sql", name: "SQL" }],
    });
    if (path === "/skills") return ok({ ok: true });
    if (path === "/admin/identity-reviews") return ok({ items: identityItems });
    if (path.startsWith("/admin/identity-reviews/") && path.endsWith("/decision")) {
      const id = path.split("/")[3];
      const body = request.postDataJSON();
      identityItems = identityItems.map((item) => item.id === id
        ? { ...item, status: body.decision, note: body.note, reviewed_at: 1763400000, reviewed_by_name: "Super Admin" }
        : item);
      return ok({ id, status: body.decision });
    }
    if (path === "/auth/change-password") return ok({ ok: true, message: "Password updated. Other signed-in devices were signed out." });
    if (path === "/auth/forgot-password") return ok({ ok: true, message: "If an account uses that address, a reset link has been sent.", reset_token: "settings-reset-token" });
    if (path === "/admin/appeals") return ok({ items: appeals });
    if (path === "/admin/console/staff") return ok({ items: staffItems });
    if (path.startsWith("/admin/console/staff/") && path.endsWith("/revoke")) {
      const id = Number(path.split("/")[4]);
      staffItems = staffItems.filter((item) => item.id !== id);
      return ok({ revoked: true, user_id: id });
    }
    if (path.startsWith("/admin/console/staff/") && request.method() === "DELETE") {
      const id = Number(path.split("/")[4]);
      staffItems = staffItems.filter((item) => item.id !== id);
      return ok({ deleted: true, user_id: id });
    }
    if (path.startsWith("/attempts/") && path.endsWith("/appeal")) return ok({ ok: true, resubmitted: true });
    if (path.startsWith("/admin/appeals/") && path.endsWith("/decision")) {
      return ok({ attempt_id: path.split("/")[3], decision: request.postDataJSON().decision, publication: { ready: true, stage: "published" }, passport_id: "appeal-passport", single_admin_override: false });
    }
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
    if (path === "/admin/console/me") return ok({ admin_role: "super_admin", user_id: 1 });
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
  const notifications = page.getByRole("region", { name: "Assessment notifications" });
  await expect(notifications).toBeVisible();
  await expect(notifications.locator(".assessment-notification-toggle")).toContainText("2");
  await expect(notifications.getByText("Awaiting review")).toHaveCount(0);
  await expect(notifications.getByText("— / 100")).toHaveCount(0);
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

test("candidate passport is issued automatically without an anonymous option", async ({ page }, testInfo) => {
  const { errors } = await workspace(page, "candidate", {
    passports: [{ id: "auto-pass", created: 1763200000, revoked: false, reviewed: true, source_attempt: "new", auto: true }],
  });
  await page.locator("button:visible").filter({ hasText: "Skill Passport" }).first().click();
  await expect(page.getByRole("heading", { name: "Skill Passport", exact: true, level: 2 })).toBeVisible();
  await expect(page.getByText("Your verified Skill Passport was created automatically after human review. You can share or revoke it below.")).toBeVisible();
  await expect(page.getByText(/Show my name/)).toHaveCount(0);
  await expect(page.getByText("Choose an approved assessment")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create passport" })).toHaveCount(0);
  await expect(page.getByText(/auto-pass/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open" })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("candidate-passport.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("candidate settings expose profile, password change and reset-link actions", async ({ page }) => {
  const { errors, calls } = await workspace(page, "candidate");
  await page.locator("button:visible").filter({ hasText: "Settings" }).first().click();
  await expect(page.getByRole("heading", { name: "Account & privacy", exact: true })).toBeVisible();
  await noOverflow(page);

  await expect(page.getByText("Sadia Rahman · sadia@example.test")).toBeVisible();
  await page.getByLabel("Current password", { exact: true }).fill("Str0ng-Passw0rd-2026");
  await page.getByLabel("New password", { exact: true }).fill("N3w-Str0ng-Passw0rd-2027");
  await page.getByLabel("Confirm new password", { exact: true }).fill("N3w-Str0ng-Passw0rd-2027");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText("Password updated. Other signed-in devices were signed out.")).toBeVisible();
  expect(calls.some((call) => call.path === "/auth/change-password" && call.method === "POST"
    && call.body.current_password === "Str0ng-Passw0rd-2026"
    && call.body.new_password === "N3w-Str0ng-Passw0rd-2027")).toBe(true);

  await page.getByRole("button", { name: "Email me a reset link" }).click();
  await expect(page.getByText("If an account uses that address, a reset link has been sent.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the reset link (development)" }))
    .toHaveAttribute("href", "#/reset-password?token=settings-reset-token");

  await page.getByRole("button", { name: "Update profile" }).click();
  await expect(page.getByRole("heading", { name: "Sadia Rahman", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("candidate can appeal a rejected assessment and answer a more-info request", async ({ page }) => {
  const invalidated = {
    id: "appeal-me", kind: "pre", status: "done", overall: null,
    review_decision: "invalidated", review_reason: "Answer evidence did not match the saved response.",
    reviewed_at: 1763200000, finalized: false, finished: 1763150000,
  };
  const { errors, calls } = await workspace(page, "candidate", { attempts: [invalidated] });
  await page.locator("button:visible").filter({ hasText: "My Exams" }).first().click();
  const record = page.locator(".assessment-record-card").first();
  await record.getByRole("textbox").fill("The answer was saved before the timer ended.");
  await record.getByRole("button", { name: "Send appeal" }).click();
  await expect(record.getByText("Appeal submitted and awaiting human review.")).toBeVisible();
  expect(calls.some((call) => call.path === "/attempts/appeal-me/appeal" && call.method === "POST"
    && call.body.note === "The answer was saved before the timer ended.")).toBe(true);
  expect(errors).toEqual([]);
});

test("candidate can add information when the reviewer requests more", async ({ page }) => {
  const moreInfo = {
    id: "appeal-more", kind: "pre", status: "done", overall: null,
    review_decision: "invalidated", review_reason: "Answer evidence did not match the saved response.",
    appeal: "The system reloaded while I was answering.",
    appeal_decision: "needs_more_info", appeal_reason: "Please add the approximate reload time and browser.",
    reviewed_at: 1763200000, finalized: false, finished: 1763150000,
  };
  const { errors, calls } = await workspace(page, "candidate", { attempts: [moreInfo] });
  await page.locator("button:visible").filter({ hasText: "My Exams" }).first().click();
  const record = page.locator(".assessment-record-card").first();
  await expect(record.getByText("Appeal review needs more information.")).toBeVisible();
  await record.getByRole("textbox").fill("It reloaded around 14:12 in Chrome.");
  await record.getByRole("button", { name: "Submit more information" }).click();
  await expect(record.getByRole("textbox")).toHaveCount(0);
  expect(calls.some((call) => call.path === "/attempts/appeal-more/appeal" && call.method === "POST"
    && call.body.note === "It reloaded around 14:12 in Chrome.")).toBe(true);
  expect(errors).toEqual([]);
});

test("overturned appeals restore the candidate's reviewed result", async ({ page }) => {
  const overturned = {
    id: "appeal-won", kind: "pre", status: "done", overall: 80,
    review_decision: "approved", review_reason: "Appeal overturned: the session log confirmed the outage.",
    appeal: "The system reloaded while I was answering.",
    appeal_decision: "overturned", appeal_reason: "The outage was confirmed from session logs.",
    reviewed_at: 1763250000, finalized: true, finished: 1763150000,
  };
  const { errors } = await workspace(page, "candidate", { attempts: [overturned] });
  await page.locator("button:visible").filter({ hasText: "My Exams" }).first().click();
  const record = page.locator(".assessment-record-card").first();
  await expect(record.getByText("Appeal reviewed: decision overturned.")).toBeVisible();
  await expect(record.getByText("The outage was confirmed from session logs.")).toBeVisible();
  await expect(record.getByRole("textbox")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("admin appeal queue handles open, blocked and final appeals", async ({ page }) => {
  const { errors, calls } = await workspace(page, "admin", {
    appeals: [
      { attempt_id: "open-appeal", candidate_name: "Sadia Rahman", email: "sadia@example.test", appeal: "Please review my saved answer.", kind: "pre", finished: 1763200000, review_decision: "invalidated", original_reviewer_id: 9, original_reviewer_name: "Reviewer One", decision: null, open: true, can_decide: true, blocked_reason: "", other_admin_available: true },
      { attempt_id: "blocked-appeal", candidate_name: "Rafi Ahmed", email: "rafi@example.test", appeal: "My network dropped.", kind: "pre", finished: 1763100000, review_decision: "invalidated", original_reviewer_id: 42, original_reviewer_name: "Admin Self", decision: "needs_more_info", open: true, can_decide: false, blocked_reason: "For separation of duties, an appeal against your own review must be decided by another administrator.", other_admin_available: true },
      { attempt_id: "closed-appeal", candidate_name: "Nabila Islam", email: "nabila@example.test", appeal: "The timer was wrong.", kind: "post", finished: 1763000000, review_decision: "invalidated", original_reviewer_id: 9, original_reviewer_name: "Reviewer One", decision: "upheld", open: false, can_decide: false, blocked_reason: "This appeal already has a final decision.", appeal_reviewer_name: "Reviewer Two", decided_at: 1763300000, other_admin_available: true },
    ],
  });
  await page.locator("button:visible").filter({ hasText: "Candidate appeals" }).first().click();
  await expect(page.getByRole("heading", { name: "Candidate appeals", exact: true, level: 2 })).toBeVisible();

  const openRow = page.locator("tr").filter({ hasText: "open-appeal" });
  await expect(openRow.getByRole("button", { name: "Overturn" })).toBeVisible();
  const blockedRow = page.locator("tr").filter({ hasText: "blocked-appeal" });
  await expect(blockedRow.getByText(/separation of duties/i)).toBeVisible();
  await expect(blockedRow.getByRole("button", { name: "Overturn" })).toHaveCount(0);
  const closedRow = page.locator("tr").filter({ hasText: "closed-appeal" });
  await expect(closedRow.getByText(/Final decision recorded/)).toBeVisible();
  await expect(closedRow.getByRole("button", { name: "Overturn" })).toHaveCount(0);

  await openRow.getByRole("button", { name: "Overturn" }).click();
  await page.getByLabel("Decision reason").fill("Session logs confirm the connection dropped before submission.");
  await page.getByRole("button", { name: "Confirm decision" }).click();
  await expect(page.getByText("Appeal overturned. The assessment was republished and a new Skill Passport was issued.")).toBeVisible();
  expect(calls.some((call) => call.path === "/admin/appeals/open-appeal/decision" && call.method === "POST"
    && call.body.decision === "overturned"
    && call.body.reason === "Session logs confirm the connection dropped before submission.")).toBe(true);
  expect(errors).toEqual([]);
});

test("super admin can revoke and delete provisioned admin accounts", async ({ page }) => {
  const { errors, calls } = await workspace(page, "admin", {
    staff: [
      { id: 1, name: "Super Admin", email: "super@example.test", admin_role: "super_admin", updated_at: 1763000000 },
      { id: 2, name: "Ops Admin", email: "ops@example.test", admin_role: "support_agent", updated_at: 1763100000 },
      { id: 3, name: "Temp Admin", email: "temp@example.test", admin_role: "finance_admin", updated_at: 1763200000 },
    ],
  });
  await page.locator("button:visible").filter({ hasText: "Admin staff & roles" }).first().click();
  await expect(page.getByRole("heading", { name: "Privileged staff access", exact: true })).toBeVisible();

  const ownRow = page.locator("tr").filter({ hasText: "super@example.test" });
  await expect(ownRow.getByText("Your account")).toBeVisible();
  await expect(ownRow.getByRole("button", { name: "Revoke admin" })).toHaveCount(0);
  await expect(ownRow.getByRole("button", { name: "Delete" })).toHaveCount(0);

  const revokeRow = page.locator("tr").filter({ hasText: "ops@example.test" });
  page.once("dialog", (dialog) => dialog.accept());
  await revokeRow.getByRole("button", { name: "Revoke admin" }).click();
  await expect(page.getByText("Admin access revoked for Ops Admin.")).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "ops@example.test" })).toHaveCount(0);

  const deleteRow = page.locator("tr").filter({ hasText: "temp@example.test" });
  page.once("dialog", (dialog) => dialog.accept());
  await deleteRow.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Admin account deleted: Temp Admin.")).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "temp@example.test" })).toHaveCount(0);

  expect(calls.some((call) => call.path === "/admin/console/staff/2/revoke" && call.method === "POST")).toBe(true);
  expect(calls.some((call) => call.path === "/admin/console/staff/3" && call.method === "DELETE")).toBe(true);
  expect(errors).toEqual([]);
});

test("candidate must confirm a mismatched CV before continuing", async ({ page }) => {
  const { errors, calls } = await workspace(page, "candidate", {
    fromProfile: false,
    hasCv: false,
    attempts: [],
    cvIdentity: {
      status: "no_match", score: 0, cv_name: "Karim Chowdhury",
      email_match: false, reasons: ["name_mismatch"], confirmed: false,
    },
  });
  await page.locator("button:visible").filter({ hasText: "Skill Journey" }).first().click();
  await page.getByPlaceholder("Paste CV text here").fill("Karim Chowdhury\nkarim@example.org\nSkills: SQL");
  await page.getByRole("button", { name: "Analyse CV" }).click();

  const identity = page.locator(".cv-identity-check");
  await expect(identity).toBeVisible();
  await expect(identity.getByText("Different name", { exact: true })).toBeVisible();
  await expect(identity.getByText("Karim Chowdhury", { exact: true })).toBeVisible();
  const confirm = page.getByRole("button", { name: "Confirm skills" });
  await expect(confirm).toBeDisabled();
  await identity.getByRole("checkbox").check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  expect(calls.some((call) => call.path === "/skills" && call.method === "PUT"
    && call.body.cv_identity_confirmed === true)).toBe(true);
  expect(errors).toEqual([]);
});

test("admin CV identity queue filters reviews and records a decision", async ({ page }) => {
  const { errors, calls } = await workspace(page, "admin", {
    identityReviews: [
      {
        id: "ir-open", user_id: 42, status: "open", created: 1763200000, reviewed_at: null,
        reviewed_by: null, reviewed_by_name: null, note: "",
        account_name: "Sadia Rahman", account_email: "sadia@example.test",
        signal: { status: "no_match", score: 0, cv_name: "Karim Chowdhury", email_match: false, confirmed: false, reasons: ["name_mismatch"] },
      },
      {
        id: "ir-cleared", user_id: 43, status: "cleared", created: 1763100000,
        reviewed_at: 1763150000, reviewed_by: 1, reviewed_by_name: "Super Admin",
        note: "Candidate supplied a matching account email.",
        account_name: "Rafi Ahmed", account_email: "rafi@example.test",
        signal: { status: "weak", score: 0.5, cv_name: "R. Ahmed", email_match: true, confirmed: true, reasons: ["account_email_found_in_cv", "name_partial_match"] },
      },
    ],
  });
  await page.locator("button:visible").filter({ hasText: "CV identity review" }).first().click();
  await expect(page.getByRole("heading", { name: "CV identity review", exact: true, level: 2 })).toBeVisible();
  await expect(page.getByText(/1 Awaiting review · 2 total/)).toBeVisible();

  const openRow = page.locator("tr").filter({ hasText: "Karim Chowdhury" });
  await expect(openRow.getByText("Different name found")).toBeVisible();
  await expect(openRow.getByText("Ownership not confirmed")).toBeVisible();
  await expect(openRow.getByText("0%")).toBeVisible();
  const scoredRow = page.locator("tr").filter({ hasText: "R. Ahmed" });
  await expect(scoredRow.getByText("Super Admin", { exact: false })).toBeVisible();
  await expect(scoredRow.getByText("Candidate supplied a matching account email.")).toBeVisible();

  await page.getByLabel("Filter CV identity reviews").selectOption("open");
  await expect(page.locator("tr").filter({ hasText: "Karim Chowdhury" })).toHaveCount(1);
  await expect(page.locator("tr").filter({ hasText: "R. Ahmed" })).toHaveCount(0);
  await page.getByLabel("Filter CV identity reviews").selectOption("all");

  await openRow.getByPlaceholder("Why did you make this decision?").fill("Candidate supplied the correct account email.");
  await openRow.getByRole("button", { name: "Mark cleared" }).click();
  await expect(page.getByText("Identity review updated.")).toBeVisible();
  const clearedRow = page.locator("tr").filter({ hasText: "Karim Chowdhury" });
  await expect(clearedRow.getByText("Cleared", { exact: true })).toBeVisible();
  await expect(clearedRow.getByRole("button", { name: "Mark cleared" })).toHaveCount(0);
  expect(calls.some((call) => call.path === "/admin/identity-reviews/ir-open/decision"
    && call.method === "POST"
    && call.body.decision === "cleared"
    && call.body.note === "Candidate supplied the correct account email.")).toBe(true);
  expect(errors).toEqual([]);
});

test("admin CV identity queue shows a clear empty state", async ({ page }) => {
  const { errors } = await workspace(page, "admin");
  await page.locator("button:visible").filter({ hasText: "CV identity review" }).first().click();
  await expect(page.getByRole("heading", { name: "CV identity review", exact: true, level: 2 })).toBeVisible();
  await expect(page.getByText("No CV identity reviews have been queued yet.")).toBeVisible();
  await expect(page.getByText("0 Awaiting review · 0 total")).toBeVisible();
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
