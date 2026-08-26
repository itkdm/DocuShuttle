import type { SupabaseClient } from "@supabase/supabase-js";

import type { WorkingDocumentAccessPort } from "../../application/document-tools";
import { SupabaseStorageAdapter } from "../../../storage/adapters/supabase-storage";
import { buildTaskObjectKey } from "@/modules/storage/object-key";

export class SupabaseWorkingDocumentAccess implements WorkingDocumentAccessPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly taskId: string,
    private readonly runId: string,
    private readonly storage = new SupabaseStorageAdapter(client),
  ) {}

  async load(): Promise<{ bytes: Uint8Array; revision: string }> {
    const document = await this.client.from("working_documents").select("current_version_id").eq("task_id", this.taskId).single();
    if (document.error || !document.data?.current_version_id) throw new Error("DOCUMENT_NOT_FOUND");
    const version = await this.client.from("document_versions").select("object_key, sha256").eq("id", document.data.current_version_id).single();
    if (version.error || !version.data) throw new Error("VERSION_NOT_FOUND");
    return { bytes: await this.storage.get(version.data.object_key as string), revision: version.data.sha256 as string };
  }

  async commit(input: { expectedRevision: string; bytes: Uint8Array; revision: string; changedEntries: readonly string[] }): Promise<{ revision: string }> {
    const run = await this.client.from("agent_runs").select("owner_user_id, working_document_id, lock_version").eq("id", this.runId).single();
    if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
    const objectKey = buildTaskObjectKey({ userId: run.data.owner_user_id as string, taskId: this.taskId, category: "versions", fileName: `${crypto.randomUUID()}.docx` });
    const manifestObjectKey = buildTaskObjectKey({ userId: run.data.owner_user_id as string, taskId: this.taskId, category: "manifests", fileName: `${crypto.randomUUID()}.json` });
    const operationLog = [{ kind: "agent-loop", changedEntries: input.changedEntries }];
    try {
      await this.storage.put(objectKey, input.bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      await this.storage.put(manifestObjectKey, new TextEncoder().encode(JSON.stringify({ revision: input.revision, changedEntries: input.changedEntries })), "application/json");
      const committed = await this.client.rpc("commit_loop_document_version", {
        p_run_id: this.runId,
        p_expected_run_version: run.data.lock_version,
        p_document_id: run.data.working_document_id,
        p_expected_revision: input.expectedRevision,
        p_derived_revision: input.revision,
        p_output_ref: JSON.stringify({ objectKey, manifestObjectKey, operationLog }),
        p_idempotency_key: `loop:${this.runId}:${input.revision}`,
      });
      if (committed.error) throw new Error(`DOCUMENT_COMMIT_FAILED: ${committed.error.message}`);
      const result = committed.data as { kind: string; actualRevision?: string; revision?: string };
      if (result.kind === "revision-conflict") throw new Error(`DOCUMENT_REVISION_CONFLICT:${result.actualRevision ?? ""}`);
      return { revision: result.revision ?? input.revision };
    } catch (error) {
      await this.storage.remove(objectKey).catch(() => undefined);
      await this.storage.remove(manifestObjectKey).catch(() => undefined);
      throw error;
    }
  }
}
