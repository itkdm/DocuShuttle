import { beforeEach, describe, expect, it, vi } from "vitest";

const getClaims = vi.fn();
const getUser = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({ auth: { getClaims, getUser } })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ getAll: () => [], set: vi.fn() })),
}));
vi.mock("./environment", () => ({
  getSupabasePublicEnvironment: () => ({ url: "https://example.supabase.co", publishableKey: "publishable-key" }),
}));
vi.mock("@/infrastructure/observability", () => ({ logger: { info: vi.fn() } }));

import { requireSupabaseIdentity } from "./server";

describe("requireSupabaseIdentity", () => {
  beforeEach(() => {
    getClaims.mockReset();
    getUser.mockReset();
  });

  it("returns the verified claims subject without fetching the Auth user record", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-123" } }, error: null });

    await expect(requireSupabaseIdentity()).resolves.toMatchObject({ userId: "user-123" });
    expect(getClaims).toHaveBeenCalledOnce();
    expect(getUser).not.toHaveBeenCalled();
  });

  it.each([
    ["claims error", { data: { claims: { sub: "user-123" } }, error: new Error("invalid token") }],
    ["missing claims", { data: { claims: undefined }, error: null }],
    ["missing subject", { data: { claims: {} }, error: null }],
    ["invalid subject", { data: { claims: { sub: "" } }, error: null }],
  ])("rejects %s as AUTHENTICATION_REQUIRED", async (_label, result) => {
    getClaims.mockResolvedValue(result);

    await expect(requireSupabaseIdentity()).rejects.toThrow("AUTHENTICATION_REQUIRED");
    expect(getUser).not.toHaveBeenCalled();
  });
});
