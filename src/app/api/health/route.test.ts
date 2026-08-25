import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("health route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports readiness without exposing credentials", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-value");
    vi.stubEnv("DEEPSEEK_API_KEY", "private-value");

    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.configured.supabase).toBe(true);
    expect(body.configured.textProvider).toBe(true);
    expect(JSON.stringify(body)).not.toContain("private-value");
    expect(JSON.stringify(body)).not.toContain("publishable-value");
  });
});
