import { expect, test } from "@playwright/test";

// The API is mocked so each test can describe a candidate's exact attempt
// history. The production rule under test lives in src/notifications.js.
async function candidateWorkspace(page, attempts, { lang = "en" } = {}) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((locale) => {
    localStorage.setItem("sb_token", "notification-test-token");
    localStorage.setItem("sb_lang", locale);
  }, lang);
  const state = {
    user: { name: "Sadia Rahman", email: "sadia@example.test" },
    consented: true,
    from_profile: true,
    has_cv: true,
    confirmed: ["sql", "python"],
    passports: [],
    attempts,
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const ok = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === "/enterprise/me") return ok({ role: "candidate", user: state.user });
    if (path === "/state") return ok(state);
    if (path === "/candidate/profile/status") return ok({ status: "confirmed" });
    return ok({ items: [] });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Career overview" })).toBeVisible();
  return { errors, state };
}

const bell = (page) => page.getByRole("button", { name: "Notifications", exact: true });
const panel = (page) => page.getByRole("region", { name: "Assessment notifications" });
const toggle = (page) => panel(page).locator(".assessment-notification-toggle");
const items = (page) => panel(page).locator(".assessment-notification-item");
const score = (page) => panel(page).locator(".assessment-notification-score");
const dot = (page) => page.locator(".tf-dot");

async function openNotifications(page) {
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
}

test("a candidate with no attempt history gets no badge and an empty state", async ({ page }) => {
  const { errors } = await candidateWorkspace(page, []);
  await expect(dot(page)).toHaveCount(0);
  await openNotifications(page);
  await expect(panel(page).getByText(/No assessment updates yet/)).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  await expect(score(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("unfinished, abandoned and first-review attempts never ring the bell", async ({ page }) => {
  const { errors } = await candidateWorkspace(page, [
    { id: "active", kind: "pre", status: "active", started: 1763300000 },
    { id: "quit", kind: "post", status: "quit", finished: 1763350000 },
    { id: "waiting", kind: "pre", status: "done", overall: null, review_decision: null, finalized: false, finished: 1763100000 },
    { id: "approved-not-published", kind: "pre", status: "done", overall: 88, review_decision: "approved", finalized: false, finished: 1763110000 },
  ]);
  await expect(dot(page)).toHaveCount(0);
  await openNotifications(page);
  await expect(panel(page).getByText(/No assessment updates yet/)).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  await expect(items(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a published result shows one notification with its real score", async ({ page }) => {
  const { errors } = await candidateWorkspace(page, [
    {
      id: "published",
      kind: "post",
      status: "done",
      overall: 86,
      review_decision: "approved",
      review_reason: "Approved after rubric review.",
      reviewed_at: 1763200000,
      finalized: true,
      finished: 1763150000,
    },
  ]);
  await expect(dot(page)).toHaveCount(1);
  await openNotifications(page);
  await expect(toggle(page)).toContainText("1");
  await expect(items(page)).toHaveCount(1);
  await expect(panel(page).getByText("Reassessment", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Assessment approved", { exact: true })).toBeVisible();
  await expect(score(page)).toHaveText("86 / 100");
  await expect(panel(page).getByText("Approved after rubric review.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a rejected assessment notifies without inventing a score and offers the appeal", async ({ page }) => {
  const { errors } = await candidateWorkspace(page, [
    {
      id: "rejected",
      kind: "pre",
      status: "done",
      overall: null,
      review_decision: "invalidated",
      review_reason: "Answer matched a published source.",
      reviewed_at: 1763200000,
      finalized: false,
      finished: 1763150000,
    },
  ]);
  await expect(dot(page)).toHaveCount(1);
  await openNotifications(page);
  await expect(panel(page).getByText("Assessment rejected", { exact: true }).first()).toBeVisible();
  await expect(panel(page).getByText("Answer matched a published source.")).toBeVisible();
  await expect(score(page)).toHaveCount(0);
  await expect(panel(page).getByText(/If you believe this rejection is incorrect/)).toBeVisible();
  await expect(panel(page).getByRole("textbox")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Send appeal" })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("a request for more information is shown as a specific review update", async ({ page }) => {
  const { errors } = await candidateWorkspace(page, [
    {
      id: "more-info",
      kind: "pre",
      status: "done",
      overall: null,
      review_decision: "needs_more_info",
      review_reason: "Explain the work history gap.",
      reviewed_at: 1763200000,
      finalized: false,
      finished: 1763150000,
    },
  ]);
  await expect(dot(page)).toHaveCount(1);
  await openNotifications(page);
  await expect(items(page).getByText("More information requested", { exact: true })).toBeVisible();
  await expect(score(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a decided appeal is reported with its decision and reason", async ({ page }) => {
  const { errors } = await candidateWorkspace(page, [
    {
      id: "appealed",
      kind: "post",
      status: "done",
      overall: null,
      review_decision: "invalidated",
      review_reason: "Integrity flag during the attempt.",
      appeal: "My network dropped and the page reloaded.",
      appeal_decision: "overturned",
      appeal_reason: "The outage was confirmed from session logs.",
      appeal_decided_at: 1763400000,
      reviewed_at: 1763200000,
      finalized: false,
      finished: 1763150000,
    },
  ]);
  await expect(dot(page)).toHaveCount(1);
  await openNotifications(page);
  await expect(items(page).getByText("Appeal reviewed: decision overturned.", { exact: true })).toBeVisible();
  await expect(items(page).getByText("The outage was confirmed from session logs.", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("textbox")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a pending appeal is reported as waiting without showing the appeal form again", async ({ page }) => {
  const { errors } = await candidateWorkspace(page, [
    {
      id: "appeal-pending",
      kind: "pre",
      status: "done",
      overall: null,
      review_decision: "invalidated",
      review_reason: "Integrity flag during the attempt.",
      appeal: "My network dropped and the page reloaded.",
      reviewed_at: 1763200000,
      finalized: false,
      finished: 1763150000,
    },
  ]);
  await expect(dot(page)).toHaveCount(1);
  await openNotifications(page);
  await expect(items(page).getByText("Appeal submitted and awaiting human review.", { exact: true })).toBeVisible();
  await expect(panel(page).getByRole("textbox")).toHaveCount(0);
  await expect(score(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("only the three newest notifications are listed while the count stays complete", async ({ page }) => {
  const { errors } = await candidateWorkspace(page, [
    [1, 61],
    [2, 62],
    [3, 63],
    [4, 64],
  ].map(([index, overall]) => ({
    id: `attempt-${index}`,
    kind: "pre",
    status: "done",
    overall,
    review_decision: "approved",
    finalized: true,
    reviewed_at: 1763200000 + index,
    finished: 1763150000 + index * 100,
  })));
  await openNotifications(page);
  await expect(toggle(page)).toContainText("4");
  await expect(items(page)).toHaveCount(3);
  await expect(items(page).first().locator(".assessment-notification-score")).toHaveText("64 / 100");
  await expect(panel(page).getByText("61 / 100")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("notification copy follows the candidate's language", async ({ page }) => {
  const { errors } = await candidateWorkspace(page, [
    { id: "published", kind: "pre", status: "done", overall: 86, review_decision: "approved", finalized: true, reviewed_at: 1763200000, finished: 1763150000 },
  ], { lang: "bn" });
  await page.getByRole("button", { name: "বিজ্ঞপ্তি", exact: true }).click();
  await expect(page.getByRole("region", { name: "Assessment notifications" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "মূল্যায়নের আপডেট" })).toBeVisible();
  await expect(page.getByText("মূল্যায়ন অনুমোদিত", { exact: true })).toBeVisible();
  await expect(page.locator(".assessment-notification-score")).toHaveText("86 / 100");
  expect(errors).toEqual([]);
});
