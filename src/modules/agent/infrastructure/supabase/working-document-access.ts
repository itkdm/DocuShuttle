import type { SupabaseClient } from "@supabase/supabase-js";

import type { DocumentEffectReceiptInput, WorkingDocumentAccessPort } from "../../application/document-tools";
import { SupabaseStorageAdapter } from "../../../storage/adapters/supabase-storage";
import { buildTaskObjectKey } from "@/modules/storage/object-key";
import { buildStableArtifactStem } from "@/modules/storage/artifact-name";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import { measure } from "@/infrastructure/observability";
import { ConcurrentRunUpdateError } from "../../domain/errors";

export class SupabaseWorkingDocumentAccess implements WorkingDocumentAccessPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly taskId: string,
    private readonly runId: string,
    private readonly getOwnedRunVersion: () => number | undefined,
    private readonly storage: PrivateObjectStoragePort = new SupabaseStorageAdapter(client),
  ) {}

  async load(): Promise<{ bytes: Uint8Array; revision: string }> {
    const document = await this.client.from("working_documents").select("current_version_id").eq("task_id", this.taskId).single();
    if (document.error || !document.data?.current_version_id) throw new Error("DOCUMENT_NOT_FOUND");
    const version = await this.client.from("document_versions").select("object_key, sha256").eq("id", document.data.current_version_id).single();
    if (version.error || !version.data) throw new Error("VERSION_NOT_FOUND");
    return { bytes: await this.storage.get(version.data.object_key as string), revision: version.data.sha256 as string };
  }

  private async ensureObject(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<{ created: boolean }> {
    if (this.storage.ensureObject) return this.storage.ensureObject(objectKey, bytes, mimeType);
    try {
      const existing = await this.storage.get(objectKey);
      if (existing.length === bytes.length && existing.every((value, index) => value === bytes[index])) return { created: false };
      throw new Error("IDEMPOTENT_ARTIFACT_CONFLICT");
    } catch (error) {
      if (error instanceof Error && error.message === "IDEMPOTENT_ARTIFACT_CONFLICT") throw error;
      await this.storage.put(objectKey, bytes, mimeType);
      return { created: true };
    }
  }

  async commit(input: { idempotencyKey: string; expectedRevision: string; bytes: Uint8Array; revision: string; changedEntries: readonly string[]; effectReceipt: DocumentEffectReceiptInput }): Promise<{ revision: string; lockVersion?: number }> {
    const expectedRunVersion = this.getOwnedRunVersion();
    if (expectedRunVersion === undefined) throw new ConcurrentRunUpdateError(this.runId);
    const run = await this.client.from("agent_runs").select("owner_user_id, working_document_id").eq("id", this.runId).single();
    if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
    const stableArtifactName = buildStableArtifactStem(input.idempotencyKey);
    const objectKey = buildTaskObjectKey({ userId: run.data.owner_user_id as string, taskId: this.taskId, category: "versions", fileName: `${stableArtifactName}.docx` });
    const manifestObjectKey = buildTaskObjectKey({ userId: run.data.owner_user_id as string, taskId: this.taskId, category: "manifests", fileName: `${stableArtifactName}.json` });
    const operationLog = [{ kind: "agent-loop", changedEntries: input.changedEntries }];
    let rpcAttempted = false;
    let createdDocxThisAttempt = false;
    let createdManifestThisAttempt = false;
    try {
      const manifestBytes = new TextEncoder().encode(JSON.stringify({ revision: input.revision, changedEntries: input.changedEntries }));
      ({ created: createdDocxThisAttempt } = await this.ensureObject(objectKey, input.bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
      ({ created: createdManifestThisAttempt } = await this.ensureObject(manifestObjectKey, manifestBytes, "application/json"));
      rpcAttempted = true;
      const committed = await measure("db.rpc", { rpc: "commit_loop_document_version", operation: "commit", table: "document_versions", runId: this.runId, documentId: run.data.working_document_id }, async () => await this.client.rpc("commit_loop_document_version", {
        p_run_id: this.runId,
        p_expected_run_version: expectedRunVersion,
        p_document_id: run.data.working_document_id,
        p_expected_revision: input.expectedRevision,
        p_derived_revision: input.revision,
        p_output_ref: JSON.stringify({ objectKey, manifestObjectKey, operationLog }),
        p_idempotency_key: input.idempotencyKey,
        p_receipt: input.effectReceipt,
      }));
      if (committed.error) throw new Error(`DOCUMENT_COMMIT_FAILED: ${committed.error.message}`);
      const result = committed.data as { kind: string; actualRevision?: string; revision?: string; lockVersion?: number };
      if (result.kind === "run-cancelled") throw new Error("RUN_CANCELLED");
      if (result.kind === "revision-conflict") throw new Error(`DOCUMENT_REVISION_CONFLICT:${result.actualRevision ?? ""}`);
      return { revision: result.revision ?? input.revision, lockVersion: result.lockVersion };
    } catch (error) {
      const semanticNoCommit = error instanceof Error && /(RUN_CANCELLED|DOCUMENT_REVISION_CONFLICT|DOCUMENT_COMMIT_CONFLICT|AGENT_RUN_CONFLICT|RUN_VERSION_CONFLICT|EFFECT_RECEIPT_CONFLICT|IDEMPOTENT_ARTIFACT_CONFLICT)/.test(error.message);
      if (!rpcAttempted || semanticNoCommit) {
        if (createdDocxThisAttempt) await this.storage.remove(objectKey).catch(() => undefined);
        if (createdManifestThisAttempt) await this.storage.remove(manifestObjectKey).catch(() => undefined);
      }
      throw error;
    }
  }
}
