import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentImageAssetReader } from "@/modules/agent/application/image-generation";
import type { UploadedImageAssetStore, UploadedImageMimeType } from "./uploaded-image-asset";
import type { DocumentPreviewAssetStore } from "./document-preview-asset";

export class SupabaseImageAssetStore implements UploadedImageAssetStore, DocumentPreviewAssetStore, AgentImageAssetReader {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: { id: string; ownerUserId: string; taskId: string; objectKey: string; mimeType: UploadedImageMimeType; sha256: string }) {
    const result = await this.client.from("assets").insert({ id: input.id, owner_user_id: input.ownerUserId, task_id: input.taskId, kind: "uploaded_image", object_key: input.objectKey, mime_type: input.mimeType, sha256: input.sha256 }).select("id").single();
    if (result.error || !result.data) throw new Error(`Unable to persist uploaded image: ${result.error?.message ?? "no row returned"}`);
  }

  async findPreviewByRequest(input: { ownerUserId: string; taskId: string; providerRequestId: string }) {
    const result = await this.client.from("assets").select("id, mime_type, sha256, width, height, document_revision, page_number").eq("owner_user_id", input.ownerUserId).eq("task_id", input.taskId).eq("kind", "preview").eq("provider_request_id", input.providerRequestId).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) return undefined;
    return { assetId: result.data.id as string, mimeType: "image/png" as const, sha256: result.data.sha256 as string, width: Number(result.data.width), height: Number(result.data.height), revision: result.data.document_revision as string, ...(result.data.page_number === null ? {} : { pageNumber: Number(result.data.page_number) }) };
  }

  async createPreview(input: { id: string; ownerUserId: string; taskId: string; objectKey: string; sha256: string; width: number; height: number; revision: string; pageNumber?: number; providerRequestId: string }) {
    const result = await this.client.from("assets").insert({ id: input.id, owner_user_id: input.ownerUserId, task_id: input.taskId, kind: "preview", object_key: input.objectKey, mime_type: "image/png", sha256: input.sha256, width: input.width, height: input.height, document_revision: input.revision, page_number: input.pageNumber ?? null, provider: "document_surface", provider_request_id: input.providerRequestId }).select("id").single();
    if (result.error || !result.data) throw new Error(`Unable to persist document preview: ${result.error?.message ?? "no row returned"}`);
  }

  async loadImage(input: { assetId: string; ownerUserId: string; taskId: string }) {
    const result = await this.client.from("assets").select("object_key, mime_type, sha256, kind").eq("id", input.assetId).eq("task_id", input.taskId).eq("owner_user_id", input.ownerUserId).in("kind", ["generated_image", "uploaded_image", "preview"]).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data ? { objectKey: result.data.object_key as string, mimeType: result.data.mime_type as string, sha256: result.data.sha256 as string, kind: result.data.kind as "generated_image" | "uploaded_image" | "preview" } : null;
  }
}
