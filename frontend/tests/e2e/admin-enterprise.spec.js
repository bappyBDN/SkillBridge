import { expect, test } from "@playwright/test";

// Synthetic admin API fixtures for paging, staff-role and appeal-outcome UI.
async function adminApp(page, { me = { admin_role: "super_admin", user_id: 1, scopes: ["*"] } } = {}) {
  const errors = [];
  const calls = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("sb_token", "admin-enterprise-token");
    localStorage.setItem("sb_lang", "en");
  });
  const users = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, name: `MOCK User ${i + 1}`, email: `user${i + 1}@example.test`, role: "candidate", created: 1763200000 }));
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    calls.push({ path, search: url.search });
    const ok = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === "/enterprise/me") return ok({ role: "admin", user: { name: "Admin", email: "admin@example.test" } });
    if (path === "/state") return ok({ user: { name: "Admin", email: "admin@example.test" }, attempts: [], passports: [] });
    if (path === "/admin/console/me") return ok(me);
    if (path === "/admin/console/overview") return ok({ counts: {}, queues: [] });
    if (path === "/admin/console/users") {
      const limit = Number(url.searchParams.get("limit") || 500);
      const offset = Number(url.searchParams.get("offset") || 0);
      return ok({ items: users.slice(offset, offset + limit), total: users.length, limit, offset });
    }
    if (path === "/admin/appeals") return ok({ items: [{ attempt_id: "hr-appeal", candidate_name: "Sadia Rahman", email: "s@example.test", appeal: "It was a TV.", appealed_outcome: "honesty_rejected", finished: 1763200000, decision: null, open: true, can_decide: true }], total: 1, limit: 100, offset: 0 });
    return ok({ items: [] });
  });
  await page.goto("/");
  return { errors, calls };
}

test("admin users list pages through the server with Prev/Next", async ({ page }) => {
  const { errors, calls } = await adminApp(page);
  await page.locator("button:visible").filter({ hasText: "Users & accounts" }).first().click();
  const pager = page.getByRole("navigation", { name: "users pages" });
  await expect(pager.getByText("1–100 of 130")).toBeVisible();
  await expect(pager.getByRole("button", { name: "Prev" })).toBeDisabled();
  await pager.getByRole("button", { name: "Next" }).click();
  await expect(pager.getByText("101–130 of 130")).toBeVisible();
  await expect(pager.getByRole("button", { name: "Next" })).toBeDisabled();
  expect(calls.some((c) => c.path === "/admin/console/users" && c.search.includes("offset=100"))).toBe(true);
  expect(errors).toEqual([]);
});

test("appeals show which outcome was appealed", async ({ page }) => {
  const { errors } = await adminApp(page);
  await page.locator("button:visible").filter({ hasText: "Candidate appeals" }).first().click();
  await expect(page.getByText("Appealed outcome: Integrity review rejected")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a staff account without a role gets a clear state instead of the super admin console", async ({ page }) => {
  const { errors } = await adminApp(page, { me: { admin_role: null, user_id: 7, scopes: [] } });
  await expect(page.getByRole("heading", { name: "No staff role assigned" })).toBeVisible();
  await expect(page.getByText(/Ask a super admin/)).toBeVisible();
  await expect(page.locator(".ad-sidebar")).toHaveCount(0);
  expect(errors).toEqual([]);
});
