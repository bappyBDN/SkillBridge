import { expect, test } from "@playwright/test";

test("the sign-in screen links to a one-time password reset flow", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/api/auth/forgot-password", (route) => route.fulfill({
    json: {
      ok: true,
      message: "If an account uses that address, a reset link has been sent.",
      reset_token: "synthetic-reset-token",
    },
  }));
  await page.route("**/api/auth/reset-password", (route) => route.fulfill({
    json: { ok: true, message: "Password updated. Sign in with your new password." },
  }));

  await page.goto("/#signin");
  await page.getByRole("link", { name: "Forgot password?" }).click();

  await expect(page.getByRole("heading", { name: "Reset your password", exact: true })).toBeVisible();
  await page.getByLabel("Email address", { exact: true }).fill("sadia@example.test");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("If an account uses that address, a reset link has been sent.")).toBeVisible();
  await page.getByRole("link", { name: "Open the reset link (development)" }).click();

  await page.getByLabel("New password", { exact: true }).fill("N3w-Str0ng-Passw0rd-2027");
  await page.getByLabel("Confirm new password", { exact: true }).fill("N3w-Str0ng-Passw0rd-2027");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText("Your password has been updated. Sign in with your new password.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "#signin");
  expect(errors).toEqual([]);
});

test("reset form blocks mismatched passwords before calling the API", async ({ page }) => {
  const errors = [];
  let resetCalls = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/auth/reset-password", (route) => {
    resetCalls += 1;
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/#/reset-password?token=synthetic-reset-token");
  await page.getByLabel("New password", { exact: true }).fill("N3w-Str0ng-Passw0rd-2027");
  await page.getByLabel("Confirm new password", { exact: true }).fill("Different-Passw0rd-2027");
  await expect(page.getByText("New passwords do not match.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set new password" })).toBeDisabled();
  await page.getByRole("button", { name: "Set new password" }).click({ force: true });
  expect(resetCalls).toBe(0);
  expect(errors).toEqual([]);
});
