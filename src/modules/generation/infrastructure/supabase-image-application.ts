import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImageCandidateSourcePort, UserDocumentVersionCommitPort, WorkingDocumentSnapshotPort } from "../application/apply-image-candidate";

export class SupabaseImageCandidateSource implements ImageCandidateSourcePort {
  constructor(private readonly client: SupabaseClient) {}
  async load(input: { assetId: string; taskId: string; ownerUserId: string }) {
    const result = await this.client.from("assets").select("object_key, mime_type").eq("id", input.assetId).eq("task_id", input.taskId).eq("owner_user_id", input.ownerUserId).eq("kind", "generated_image").maybeSingle();
    if (result.error) throw new Error(`Unable to load image candidate: ${result.error.message}`);
    return result.data ? { objectKey: result.data.object_key as string, mimeType: result.data.mime_type as string } : null;
  }
}

export class SupabaseWorkingDocumentSnapshot implements WorkingDocumentSnapshotPort {
  constructor(private readonly client: SupabaseClient) {}
  async load(input: { taskId: string; ownerUserId: string }) {
    const result = await this.client.from("working_documents").select("id, revision, current_version_id").eq("task_id", input.taskId).eq("owner_user_id", input.ownerUserId).maybeSingle();
    if (result.error || !result.data?.current_version_id) return null;
    const version = await this.client.from("document_versions").select("object_key, version_number, sha256").eq("id", result.data.current_version_id).eq("owner_user_id", input.ownerUserId).single();
    if (version.error || !version.data) return null;
    return { documentId: result.data.id as string, objectKey: version.data.object_key as string, revision: version.data.sha256 as string, versionNumber: Number(version.data.version_number) };
  }
}

export class SupabaseUserDocumentVersionCommit implements UserDocumentVersionCommitPort {
  constructor(private readonly client: SupabaseClient) {}
  async commit(input: Parameters<UserDocumentVersionCommitPort["commit"]>[0]) {
    const result = await this.client.rpc("commit_user_document_version", { p_document_id: input.documentId, p_expected_revision: input.expectedRevision, p_derived_revision: input.derivedRevision, p_output_ref: input.objectKey, p_manifest_object_key: input.manifestObjectKey, p_validation: input.validation, p_operation_log: input.operationLog });
    if (result.error) throw new Error(`Unable to commit image version: ${result.error.message}`);
    const row = result.data as { version_id?: string; version_number?: number; kind?: string; actual_revision?: string };
    if (row.kind === "revision-conflict") return { kind: "revision-conflict" as const, actualRevision: row.actual_revision ?? "" };
    if (!row.version_id) throw new Error("Unable to commit image version: no version returned");
    return { versionId: row.version_id, versionNumber: Number(row.version_number) };
  }
}
