import { expect, test } from "@playwright/test";

// Synthetic API fixtures (page.route) for the unified notification center,
// review replies, honesty outcomes, applications and data rights.
async function mockApp(page, role, options = {}) {
  const {
    attempts = [],
    notifications = [],
    notificationsStatus = 200,
    applications = [],
    invites = [],
    exportStatus = 200,
  } = options;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("sb_token", "notification-center-token");
    localStorage.setItem("sb_lang", "en");
  });
  const state = {
    user: { name: "Sadia Rahman", email: "center@example.test" }, consented: true, from_profile: true,
    has_cv: true, confirmed: ["sql"], passports: [], attempts,
  };
  const store = { notifications: notifications.map((item) => ({ ...item })), applications: applications.map((a) => ({ ...a })), invites: invites.map((i) => ({ ...i })) };
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    let body = null;
    try { body = request.postDataJSON(); } catch { body = null; }
    calls.push({ path, method: request.method(), body, search: url.search });
    const ok = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === "/enterprise/me") return ok({ role, user: state.user });
    if (path === "/state") return ok(state);
    if (path === "/candidate/profile/status") return ok({ status: "confirmed" });
    if (path === "/notifications") {
      if (notificationsStatus !== 200) return ok({ detail: "Not Found" }, notificationsStatus);
      return ok({ items: store.notifications, unread: store.notifications.filter((n) => !n.read_at).length });
    }
    if (path === "/notifications/read") {
      const ids = new Set(body?.ids || []);
      store.notifications = store.notifications.map((n) => (ids.has(n.id) || body?.all ? { ...n, read_at: n.read_at || 1763500000 } : n));
      return ok({ ok: true, unread: store.notifications.filter((n) => !n.read_at).length });
    }
    if (path.endsWith("/review-response")) {
      const id = path.split("/")[2];
      state.attempts = state.attempts.map((a) => (a.id === id ? { ...a, review_response: { note: body.note, created: 1763500000 } } : a));
      return ok({ ok: true, review_response: { note: body.note, created: 1763500000 } });
    }
    if (path.endsWith("/appeal")) {
      const id = path.split("/")[2];
      state.attempts = state.attempts.map((a) => (a.id === id ? { ...a, appeal: body.note } : a));
      return ok({ ok: true });
    }
    if (path === "/applications/mine") return ok({ items: store.applications });
    if (path.startsWith("/applications/") && path.endsWith("/withdraw")) {
      const id = path.split("/")[2];
      store.applications = store.applications.map((a) => (a.application_id === id ? { ...a, status: "withdrawn" } : a));
      return ok({ application_id: id, from: "submitted", status: "withdrawn" });
    }
    if (path === "/candidate/phase-two-invites") return ok({ items: store.invites });
    if (path.startsWith("/candidate/phase-two-invites/") && path.endsWith("/respond")) {
      const id = path.split("/")[3];
      const status = body.decision === "accept" ? "accepted" : "declined";
      store.invites = store.invites.map((i) => (i.id === id ? { ...i, status } : i));
      return ok({ ok: true, status });
    }
    if (path === "/me/export") return exportStatus === 200 ? ok({ user: state.user }) : ok({ detail: "export_unavailable_now" }, exportStatus);
    if (path === "/company/workspace") return ok({ company: { id: "company-1", name: "Northstar Technologies", verified: true, role: "owner" }, verification: { status: "verified" }, permissions: { manage_team: true, manage_jobs: true, manage_pipeline: true, view_reports: true }, job_eligibility: { can_create_draft: true, can_publish: true } });
    if (path === "/company/analytics") return ok({ totals: { jobs: 0, published_jobs: 0, applicants: 0, shared_results: 0 }, stages: [], jobs: [] });
    if (path === "/admin/console/me") return ok({ admin_role: "super_admin", user_id: 1, scopes: [] });
    if (path === "/admin/console/overview") return ok({ counts: {}, queues: [] });
    return ok({ items: [] });
  });
  await page.goto("/");
  return { errors, calls, state, store };
}

const serverItem = (id, created, extra = {}) => ({ id, kind: "application_stage", title: `Update ${id}`, body: `Body ${id}`, link: "applications", created, read_at: null, ...extra });
const bell = (page) => page.getByRole("button", { name: "Notifications", exact: true });
const candidatePanel = (page) => page.getByRole("region", { name: "Assessment notifications" });

test("candidate bell merges server notifications, marks them read and navigates by link", async ({ page }) => {
  const { errors, calls } = await mockApp(page, "candidate", {
    attempts: [{ id: "p", kind: "pre", status: "done", overall: 81, review_decision: "approved", finalized: true, reviewed_at: 1763200000, finished: 1763100000 }],
    notifications: [serverItem("n-new", 1763300000), serverItem("n-old", 1763000000, { read_at: 1763050000 })],
  });
  await expect(page.getByRole("heading", { name: "Career overview" })).toBeVisible();
  await expect(page.getByTestId("notification-badge")).toHaveText("2");
  await bell(page).click();
  const items = candidatePanel(page).locator(".assessment-notification-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("Update n-new");
  await expect(items.nth(1).locator(".assessment-notification-score")).toHaveText("81 / 100");
  await expect(items.nth(2)).toContainText("Update n-old");
  await expect.poll(() => calls.some((c) => c.path === "/notifications/read" && c.body?.ids?.includes("n-new"))).toBe(true);
  await expect(page.getByTestId("notification-badge")).toHaveCount(0);
  await candidatePanel(page).getByRole("button", { name: /Update n-new/ }).click();
  await expect(candidatePanel(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Applications", exact: true })).toBeVisible();
  expect(calls.find((c) => c.path === "/notifications")?.search).toBe("?limit=50");
  expect(errors).toEqual([]);
});

test("the candidate bell still works when the notification endpoint is not deployed", async ({ page }) => {
  const { errors } = await mockApp(page, "candidate", { notificationsStatus: 404 });
  await expect(page.getByRole("heading", { name: "Career overview" })).toBeVisible();
  await bell(page).click();
  await expect(candidatePanel(page).getByText(/No assessment updates yet/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("a needs-more-info review shows the reason and accepts a reply", async ({ page }) => {
  const { errors, calls } = await mockApp(page, "candidate", {
    attempts: [{ id: "info", kind: "pre", status: "done", overall: null, review_decision: "needs_more_info", review_reason: "Explain the tab switch at question 7.", reviewed_at: 1763200000, finished: 1763100000, review_response: null, review_response_allowed: true }],
  });
  await bell(page).click();
  const panel = candidatePanel(page);
  await expect(panel.getByText("Explain the tab switch at question 7.")).toBeVisible();
  await expect(panel.getByText(/Action needed/)).toBeVisible();
  const send = panel.getByRole("button", { name: "Send reply" });
  await expect(send).toBeDisabled();
  await panel.getByLabel("Your reply to the reviewer").fill("A delivery person rang the bell; I returned immediately.");
  await send.click();
  await expect(panel.getByText("Response sent — awaiting reviewer")).toBeVisible();
  expect(calls.find((c) => c.path === "/attempts/info/review-response")?.body).toEqual({ note: "A delivery person rang the bell; I returned immediately." });
  expect(errors).toEqual([]);
});

test("an honesty rejection is a neutral, notified outcome with an appeal form", async ({ page }) => {
  const { errors, calls } = await mockApp(page, "candidate", {
    attempts: [{ id: "hr", kind: "pre", status: "done", overall: null, review_decision: "approved", finalized: false, finished: 1763100000, honesty_status: "rejected", honesty_reason: "A second voice was heard for most of the attempt.", publication_stage: "honesty_rejected", appealable: true, honesty: { status: "rejected", reviewed_at: 1763300000 } }],
  });
  await expect(page.getByTestId("notification-badge")).toHaveText("1");
  await bell(page).click();
  const panel = candidatePanel(page);
  await expect(panel.getByText("Not verified after integrity review").first()).toBeVisible();
  await expect(panel.getByText(/not an automatic decision/)).toBeVisible();
  await expect(panel.getByText("A second voice was heard for most of the attempt.")).toBeVisible();
  await expect(panel.locator(".assessment-notification-score")).toHaveCount(0);
  await panel.getByRole("textbox").fill("It was a television in the next room.");
  await panel.getByRole("button", { name: "Send appeal" }).click();
  await expect.poll(() => calls.some((c) => c.path === "/attempts/hr/appeal")).toBe(true);
  expect(errors).toEqual([]);
});

test("company and admin workspaces have a server notification bell", async ({ page }) => {
  const company = await mockApp(page, "company", { notifications: [serverItem("c1", 1763300000, { title: "New applicant", link: "company-applications" })] });
  const companyBell = page.getByRole("button", { name: "Notifications", exact: true });
  await expect(companyBell).toBeVisible();
  await companyBell.click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("New applicant")).toBeVisible();
  await expect.poll(() => company.calls.some((c) => c.path === "/notifications/read")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Notifications" })).toHaveCount(0);
  expect(company.errors).toEqual([]);
});

test("admin bell lists server notifications and shows an empty state", async ({ page }) => {
  const admin = await mockApp(page, "admin", { notifications: [] });
  const adminBell = page.getByRole("button", { name: "Notifications", exact: true });
  await expect(adminBell).toBeVisible();
  await adminBell.click();
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("No notifications yet.")).toBeVisible();
  expect(admin.errors).toEqual([]);
});

test("candidate withdraws an application and answers a next-stage invitation", async ({ page }) => {
  const { errors, calls } = await mockApp(page, "candidate", {
    applications: [
      { application_id: "app-1", job_id: "job-1", title: "Junior Data Analyst", company_name: "MOCK Northstar", location: "Remote", status: "submitted", results_shared: false },
      { application_id: "app-2", job_id: "job-2", title: "BI Intern", company_name: "MOCK Delta", location: "Dhaka", status: "hired", results_shared: true },
    ],
    invites: [{ id: "inv-1", application_id: "app-1", job_title: "Junior Data Analyst", company_name: "MOCK Northstar", title: "SQL case study", requirements: "45 minutes, SQL only", deadline: "2099-01-31", status: "approved" }],
  });
  await page.getByRole("button", { name: "My applications", exact: true }).filter({ visible: true }).first().click();
  const invite = page.locator('[data-invite-id="inv-1"]');
  await expect(invite.getByText("Awaiting your response")).toBeVisible();
  await expect(invite).toContainText("2099-01-31");
  await invite.getByRole("button", { name: "Accept" }).click();
  const dialog = page.getByRole("dialog", { name: "Accept this invitation?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Invitation accepted.")).toBeVisible();
  await expect(invite.getByText("Accepted", { exact: true })).toBeVisible();
  expect(calls.find((c) => c.path === "/candidate/phase-two-invites/inv-1/respond")?.body).toEqual({ decision: "accept" });

  await expect(page.locator('[data-application-id="app-2"]').getByRole("button", { name: "Withdraw" })).toHaveCount(0);
  await page.locator('[data-application-id="app-1"]').getByRole("button", { name: "Withdraw" }).click();
  const confirm = page.getByRole("dialog", { name: "Withdraw this application?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(calls.some((c) => c.path.endsWith("/withdraw"))).toBe(false);
  await page.locator('[data-application-id="app-1"]').getByRole("button", { name: "Withdraw" }).click();
  await page.getByRole("dialog", { name: "Withdraw this application?" }).getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("Application withdrawn.")).toBeVisible();
  await expect(page.locator('[data-application-id="app-1"]').getByText("withdrawn")).toBeVisible();
  expect(errors).toEqual([]);
});

test("data export failures are shown and deleting asks for confirmation", async ({ page }) => {
  const { errors, calls } = await mockApp(page, "candidate", { exportStatus: 503 });
  await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Export my data" }).click();
  await expect(page.getByText(/Something went wrong/).first()).toBeVisible();
  await expect(page.getByText("export_unavailable_now", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Delete my account" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete my account" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(calls.some((c) => c.path === "/me" && c.method === "DELETE")).toBe(false);
  expect(errors).toEqual([]);
});
