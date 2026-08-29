import { describe, expect, it } from "vitest";
import { toDomain, toInsert, toPatch, type ImageGenerationJobRow } from "./supabase-generated-asset-store";
import type { ImageGenerationJob } from "@/modules/agent/application/image-generation";

const input: Omit<ImageGenerationJob, "status" | "createdAt" | "updatedAt"> = {
  id: "job-1", ownerUserId: "owner", taskId: "task", runId: "run", callId: "call", idempotencyKey: "key", requestHash: "hash", provider: "fake", model: "model", candidateAssetId: "asset", safeRequest: { prompt: "duck" }, providerTaskId: "provider-task",
};

describe("Supabase image generation job mapping", () => {
  it("writes the database contract in snake_case", () => {
    const row = toInsert(input);
    expect(row).toMatchObject({ owner_user_id: "owner", idempotency_key: "key", request_hash: "hash", provider_task_id: "provider-task", candidate_asset_id: "asset", safe_request: { prompt: "duck" } });
    expect(row).not.toHaveProperty("ownerUserId");
    expect(row).not.toHaveProperty("idempotencyKey");
  });

  it("maps database rows and patches without leaking snake_case into domain", () => {
    const row: ImageGenerationJobRow = { ...toInsert(input), created_at: "2026-08-29T00:00:00.000Z", updated_at: "2026-08-29T00:00:00.000Z", result: null };
    const domain = toDomain(row);
    expect(domain).toMatchObject({ ownerUserId: "owner", idempotencyKey: "key", providerTaskId: "provider-task", candidateAssetId: "asset" });
    expect(toPatch({ status: "submitted", providerTaskId: "next", errorCode: "E" })).toEqual({ status: "submitted", provider_task_id: "next", error_code: "E" });
  });
});
