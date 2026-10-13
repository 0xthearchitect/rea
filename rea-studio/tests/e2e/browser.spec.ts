import { test, expect } from "@playwright/test";
test("browser preview reports unavailable native integration and preserves layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Start with the evidence." }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: "New investigation", exact: true })
      .first(),
  ).toBeDisabled();
  await expect(page.getByText("Desktop required").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Connection settings", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("This is a browser preview.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Agent workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Agent integration is not configured" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await page
    .getByRole("button", { name: "Investigations", exact: true })
    .click();
  await page.screenshot({ path: ".local/studio-first-launch.png" });
  expect(errors).toEqual([]);
});
