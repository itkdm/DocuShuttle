import { expect, test } from "@playwright/test";

test.describe("PaperDuck workbench", () => {
  test("health endpoint is reachable", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  test("opens the real DOCX workbench shell", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/PaperDuck|纸上鸭/i);
    await expect(page.getByText("把一份真实 Word 放到桌上")).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(3);
    await expect(page.getByText("文档结构")).toBeVisible();
    await expect(page.getByText("Agent 状态")).toBeVisible();
  });
});
