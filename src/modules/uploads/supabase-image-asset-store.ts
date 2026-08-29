import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentImageAssetReader } from "@/modules/agent/application/image-generation";
import type { UploadedImageAssetStore, UploadedImageMimeType } from "./uploaded-image-asset";

export class SupabaseImageAssetStore implements UploadedImageAssetStore, AgentImageAssetReader {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: { id: string; ownerUserId: string; taskId: string; objectKey: string; mimeType: UploadedImageMimeType; sha256: string }) {
    const result = await this.client.from("assets").insert({ id: input.id, owner_user_id: input.ownerUserId, task_id: input.taskId, kind: "uploaded_image", object_key: input.objectKey, mime_type: input.mimeType, sha256: input.sha256 }).select("id").single();
    if (result.error || !result.data) throw new Error(`Unable to persist uploaded image: ${result.error?.message ?? "no row returned"}`);
  }

  async loadImage(input: { assetId: string; ownerUserId: string; taskId: string }) {
    const result = await this.client.from("assets").select("object_key, mime_type, sha256, kind").eq("id", input.assetId).eq("task_id", input.taskId).eq("owner_user_id", input.ownerUserId).in("kind", ["generated_image", "uploaded_image"]).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? { objectKey: result.data.object_key as string, mimeType: result.data.mime_type as string, sha256: result.data.sha256 as string, kind: result.data.kind as "generated_image" | "uploaded_image" } : null;
  }
}
