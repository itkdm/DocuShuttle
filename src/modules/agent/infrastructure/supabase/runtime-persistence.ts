import type { SupabaseClient } from "@supabase/supabase-js";

import type { PrivateObjectStoragePort } from "@/modules/storage/ports";

import type { AgentRunEvent } from "../../application/events";
import type {
  AgentRunStore,
  CancelledEffectReconciler,
  CommitDerivedVersionInput,
  CommitDerivedVersionResult,
  DocumentVersionCommitPort,
  EffectReceiptStore,
} from "../../application/ports";
import { ConcurrentRunUpdateError } from "../../domain/errors";
import { createAgentRun, type AgentRun, type SideEffectReceipt } from "../../domain/model";

const fail = (context: string, error: { message: string; code?: string } | null): void => {
  if (error) throw new Error(`${context}: ${error.code ?? "DATABASE_ERROR"}: ${error.message}`);
};

export class SupabaseAgentRunStore implements AgentRunStore {
  constructor(private readonly client: SupabaseClient) {}

  async createForTask(input: { taskId: string; ownerUserId: string; now: string }): Promise<AgentRun> {
    const document = await this.client
      .from("working_documents")
      .select("id")
      .eq("task_id", input.taskId)
      .eq("owner_user_id", input.ownerUserId)
      .single();
    fail("Unable to load working document", document.error);
    if (!document.data) throw new Error("WORKING_DOCUMENT_NOT_FOUND");
    const documentId = document.data.id as string;
    const revision = await this.currentRevision(documentId);
    const run = createAgentRun({
      id: crypto.randomUUID(),
      documentId,
      baseRevision: revision,
      now: input.now,
    });
    const created = await this.client.from("agent_runs").insert({
      id: run.id,
      owner_user_id: input.ownerUserId,
      task_id: input.taskId,
      working_document_id: documentId,
      base_revision: revision,
      status: run.status,
      lock_version: run.version,
      state: run,
    });
    fail("Unable to create agent run", created.error);
    return run;
  }

  async load(runId: string): Promise<AgentRun | null> {
    const result = await this.client.from("agent_runs").select("state").eq("id", runId).maybeSingle();
    fail("Unable to load agent run", result.error);
    return result.data ? result.data.state as AgentRun : null;
  }

  async save(run: AgentRun, expectedVersion: number, events: readonly AgentRunEvent[]): Promise<AgentRun> {
    const result = await this.client.rpc("save_agent_run", {
      p_run_id: run.id,
      p_expected_version: expectedVersion,
      p_state: run,
      p_events: events,
    });
    if (result.error) throw new ConcurrentRunUpdateError(run.id);
    return result.data as AgentRun;
  }

  private async currentRevision(documentId: string): Promise<string> {
    const result = await this.client.rpc("get_current_document_revision", { p_document_id: documentId });
    fail("Unable to load document revision", result.error);
    if (typeof result.data !== "string" || !result.data) throw new Error("DOCUMENT_REVISION_NOT_FOUND");
    return result.data;
  }
}

export class SupabaseEffectReceiptStore implements EffectReceiptStore {
  constructor(private readonly client: SupabaseClient, private readonly runId: string) {}

  async load(idempotencyKey: string): Promise<SideEffectReceipt | null> {
    const result = await this.client
      .from("agent_effect_receipts")
      .select("receipt")
      .eq("run_id", this.runId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    fail("Unable to load effect receipt", result.error);
    return result.data ? result.data.receipt as SideEffectReceipt : null;
  }

  async saveOnce(receipt: SideEffectReceipt): Promise<SideEffectReceipt> {
    const result = await this.client.rpc("save_effect_receipt", {
      p_run_id: this.runId,
      p_receipt: receipt,
    });
    fail("Unable to save effect receipt", result.error);
    return result.data as SideEffectReceipt;
  }
}

export class SupabaseDocumentVersionCommit implements DocumentVersionCommitPort {
  constructor(private readonly client: SupabaseClient) {}

  async getCurrentRevision(documentId: string): Promise<string> {
    const result = await this.client.rpc("get_current_document_revision", { p_document_id: documentId });
    fail("Unable to load document revision", result.error);
    if (typeof result.data !== "string" || !result.data) throw new Error("DOCUMENT_REVISION_NOT_FOUND");
    return result.data;
  }

  async commitDerivedVersion(input: CommitDerivedVersionInput): Promise<CommitDerivedVersionResult> {
    const result = await this.client.rpc("commit_derived_document_version", {
      p_run_id: input.runId,
      p_expected_run_version: input.expectedRunVersion,
      p_document_id: input.documentId,
      p_expected_revision: input.expectedRevision,
      p_derived_revision: input.derivedRevision,
      p_output_ref: input.outputRef,
      p_idempotency_key: input.idempotencyKey,
    });
    fail("Unable to commit document version", result.error);
    return result.data as CommitDerivedVersionResult;
  }
}

export class StorageCancelledEffectReconciler implements CancelledEffectReconciler {
  constructor(private readonly storage: PrivateObjectStoragePort) {}

  async reconcileCancelled(_run: AgentRun, receipt: SideEffectReceipt): Promise<void> {
    if (receipt.effect !== "apply") return;
    try {
      const output = JSON.parse(receipt.outputRef) as { objectKey?: string; manifestObjectKey?: string };
      if (output.objectKey) await this.storage.remove(output.objectKey);
      if (output.manifestObjectKey) await this.storage.remove(output.manifestObjectKey);
    } catch {
      // A malformed or already-reconciled receipt has no safe object target to remove.
    }
  }
}
