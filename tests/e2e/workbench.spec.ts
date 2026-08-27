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
    await expect(page.getByText("任务会话")).toBeVisible();
    await expect(page.getByText("Agent 状态")).toBeVisible();
    await expect(page.getByRole("button", { name: "新任务" })).toBeVisible();
  });

  test("home does not restore a previous workspace from localStorage", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("paperduck-workbench-resume-v1", JSON.stringify({
        taskId: "0872a73c-d403-429c-9ca7-d0e629b36c69",
        runId: "6f1d2c3b-4a5e-6789-abcd-ef0123456789",
        fileName: "上次的实验报告.docx",
      }));
    });
    await page.goto("/");
    await expect(page.getByText("把一份真实 Word 放到桌上")).toBeVisible();
    await expect(page.getByText("上次的实验报告.docx")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });
});
