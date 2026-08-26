import type { SupabaseClient } from "@supabase/supabase-js";

import type { GeneratedAssetStorePort } from "../application/generate-image-candidates";

export class SupabaseGeneratedAssetStore implements GeneratedAssetStorePort {
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
}
