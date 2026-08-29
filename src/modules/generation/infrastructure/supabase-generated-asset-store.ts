import type { SupabaseClient } from "@supabase/supabase-js";

import type { GeneratedAssetStorePort } from "../application/generate-image-candidates";
import type { AgentImageAssetReader, GeneratedAgentAssetStore, ImageGenerationJob, ImageGenerationJobStore } from "@/modules/agent/application/image-generation";

export type ImageGenerationJobRow = {
  id: string; owner_user_id: string; task_id: string; run_id: string; call_id: string;
  idempotency_key: string; request_hash: string; provider: string; model: string | null;
  status: ImageGenerationJob["status"]; provider_task_id: string | null; candidate_asset_id: string;
  safe_request: unknown; result: unknown; error_code: string | null; error_message: string | null;
  created_at: string; updated_at: string;
};

export const toDomain = (row: ImageGenerationJobRow): ImageGenerationJob => ({
  id: row.id, ownerUserId: row.owner_user_id, taskId: row.task_id, runId: row.run_id, callId: row.call_id,
  idempotencyKey: row.idempotency_key, requestHash: row.request_hash, provider: row.provider, ...(row.model ? { model: row.model } : {}), status: row.status,
  ...(row.provider_task_id ? { providerTaskId: row.provider_task_id } : {}), candidateAssetId: row.candidate_asset_id,
  safeRequest: row.safe_request, ...(row.result !== null ? { result: row.result } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.error_message ? { errorMessage: row.error_message } : {}), createdAt: row.created_at, updatedAt: row.updated_at,
});
export const toInsert = (input: Omit<ImageGenerationJob, "status" | "createdAt" | "updatedAt">) => ({
  id: input.id, owner_user_id: input.ownerUserId, task_id: input.taskId, run_id: input.runId, call_id: input.callId,
  idempotency_key: input.idempotencyKey, request_hash: input.requestHash, provider: input.provider, model: input.model ?? null,
  status: "created" as const, provider_task_id: input.providerTaskId ?? null, candidate_asset_id: input.candidateAssetId,
  safe_request: input.safeRequest, result: input.result ?? null, error_code: input.errorCode ?? null, error_message: input.errorMessage ?? null,
});
export const toPatch = (patch: Parameters<ImageGenerationJobStore["update"]>[1]) => ({
  ...(patch.status ? { status: patch.status } : {}), ...(patch.providerTaskId !== undefined ? { provider_task_id: patch.providerTaskId } : {}),
  ...(patch.result !== undefined ? { result: patch.result } : {}), ...(patch.errorCode !== undefined ? { error_code: patch.errorCode } : {}), ...(patch.errorMessage !== undefined ? { error_message: patch.errorMessage } : {}),
});

export class SupabaseGeneratedAssetStore implements GeneratedAssetStorePort, GeneratedAgentAssetStore, AgentImageAssetReader {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Parameters<GeneratedAssetStorePort["create"]>[0]): Promise<{ id: string }> {
    const result = await this.client.from("assets").insert({
      id: input.id,
      owner_user_id: input.ownerUserId,
      task_id: input.taskId,
      kind: "generated_image",
      object_key: input.objectKey,
      mime_type: input.mimeType,
      sha256: input.sha256,
      provider: input.provider,
      provider_request_id: input.providerRequestId,
      prompt: input.prompt,
    }).select("id").single();
    if (result.error || !result.data) throw new Error(`Unable to persist generated image: ${result.error?.message ?? "no row returned"}`);
    return { id: result.data.id as string };
  }

  async ensureGenerated(input: Parameters<GeneratedAgentAssetStore["ensureGenerated"]>[0]): Promise<{ id: string }> {
    const existing = await this.client.from("assets").select("id, object_key, sha256, mime_type, provider").eq("id", input.id).eq("owner_user_id", input.ownerUserId).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      if (existing.data.object_key !== input.objectKey || existing.data.sha256 !== input.sha256 || existing.data.mime_type !== input.mimeType || existing.data.provider !== input.provider) throw new Error("ASSET_IDEMPOTENCY_CONFLICT");
      return { id: input.id };
    }
    return this.create(input);
  }

  async load(input: Parameters<GeneratedAgentAssetStore["load"]>[0]) {
    const result = await this.client.from("assets").select("object_key, mime_type, sha256, provider").eq("id", input.assetId).eq("task_id", input.taskId).eq("owner_user_id", input.ownerUserId).eq("kind", "generated_image").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? { objectKey: result.data.object_key as string, mimeType: result.data.mime_type as string, sha256: result.data.sha256 as string, provider: result.data.provider as string | undefined } : null;
  }

  async loadImage(input: Parameters<AgentImageAssetReader["loadImage"]>[0]) {
    const result = await this.client.from("assets").select("object_key, mime_type, sha256, kind").eq("id", input.assetId).eq("task_id", input.taskId).eq("owner_user_id", input.ownerUserId).in("kind", ["generated_image", "uploaded_image", "preview"]).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? { objectKey: result.data.object_key as string, mimeType: result.data.mime_type as string, sha256: result.data.sha256 as string, kind: result.data.kind as "generated_image" | "uploaded_image" | "preview" } : null;
  }
}

export class SupabaseImageGenerationJobStore implements ImageGenerationJobStore {
  constructor(private readonly client: SupabaseClient) {}
  async createOrGet(input: Omit<ImageGenerationJob, "status" | "createdAt" | "updatedAt">): Promise<ImageGenerationJob> {
    const result = await this.client.from("image_generation_jobs").insert(toInsert(input)).select("*").single();
    if (!result.error && result.data) return toDomain(result.data as ImageGenerationJobRow);
    if (result.error?.code === "23505") {
      const existing = await this.get(input.idempotencyKey);
      if (existing && existing.requestHash === input.requestHash) return existing;
      throw new Error("IMAGE_GENERATION_IDEMPOTENCY_CONFLICT");
    }
    throw new Error(result.error?.message ?? "Unable to create image generation job");
  }
  async get(idempotencyKey: string): Promise<ImageGenerationJob | undefined> { const result = await this.client.from("image_generation_jobs").select("*").eq("idempotency_key", idempotencyKey).maybeSingle(); if (result.error) throw new Error(result.error.message); return result.data ? toDomain(result.data as ImageGenerationJobRow) : undefined; }
  async claimForSubmission(id: string) { const result = await this.client.from("image_generation_jobs").update({ status: "submitting", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "created").select("id").maybeSingle(); if (result.error) throw new Error(result.error.message); return Boolean(result.data); }
  async update(id: string, patch: Parameters<ImageGenerationJobStore["update"]>[1]) { const result = await this.client.from("image_generation_jobs").update({ ...toPatch(patch), updated_at: new Date().toISOString() }).eq("id", id).select("*").single(); if (result.error || !result.data) throw new Error(result.error?.message ?? "Unable to update image generation job"); return toDomain(result.data as ImageGenerationJobRow); }
}
