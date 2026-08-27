import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

describe("development log endpoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is unavailable in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(new Request("http://localhost/api/dev/logs", { method: "POST", body: "{}" }));
    expect(response.status).toBe(404);
  });

  it("accepts only the bounded development batch shape", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = await POST(new Request("http://localhost/api/dev/logs", { method: "POST", body: JSON.stringify({ events: [{ event: "client.fetch.completed", route: "/api/health", status: 200, durationMs: 3 }] }) }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });
});
