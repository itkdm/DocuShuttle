import type { SupabaseClient } from "@supabase/supabase-js";

import type { GeneratedAssetStorePort } from "../application/generate-image-candidates";
import type { GeneratedAgentAssetStore, ImageGenerationJob, ImageGenerationJobStore } from "@/modules/agent/application/image-generation";

export class SupabaseGeneratedAssetStore implements GeneratedAssetStorePort, GeneratedAgentAssetStore {
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
    const existing = await this.client.from("assets").select("id, object_key, sha256").eq("id", input.id).eq("owner_user_id", input.ownerUserId).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      if (existing.data.object_key !== input.objectKey || existing.data.sha256 !== input.sha256) throw new Error("IDEMPOTENT_ARTIFACT_CONFLICT");
      return { id: input.id };
    }
    return this.create(input);
  }

  async load(input: Parameters<GeneratedAgentAssetStore["load"]>[0]) {
    const result = await this.client.from("assets").select("object_key, mime_type, sha256").eq("id", input.assetId).eq("task_id", input.taskId).eq("owner_user_id", input.ownerUserId).eq("kind", "generated_image").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? { objectKey: result.data.object_key as string, mimeType: result.data.mime_type as string, sha256: result.data.sha256 as string } : null;
  }
}

export class SupabaseImageGenerationJobStore implements ImageGenerationJobStore {
  constructor(private readonly client: SupabaseClient) {}
  async create(input: Parameters<ImageGenerationJobStore["create"]>[0]) {
    const result = await this.client.from("image_generation_jobs").insert({ ...input, status: "created" }).select("*").single();
    if (result.error || !result.data) throw new Error(result.error?.message ?? "Unable to create image generation job");
    return result.data as unknown as ImageGenerationJob;
  }
  async get(idempotencyKey: string) { const result = await this.client.from("image_generation_jobs").select("*").eq("idempotency_key", idempotencyKey).maybeSingle(); if (result.error) throw new Error(result.error.message); return result.data as ImageGenerationJob | undefined; }
  async update(id: string, patch: Parameters<ImageGenerationJobStore["update"]>[1]) { const result = await this.client.from("image_generation_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single(); if (result.error || !result.data) throw new Error(result.error?.message ?? "Unable to update image generation job"); return result.data as unknown as ImageGenerationJob; }
}
