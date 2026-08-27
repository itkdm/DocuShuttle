import type { SupabaseClient } from "@supabase/supabase-js";

import type { PrivateObjectStoragePort } from "@/modules/storage/ports";

import type { AgentRunEvent } from "../../application/events";
import type {
  AgentRunStore,
  CancelledEffectReconciler,
  CommitDerivedVersionInput,
  CommitDerivedVersionResult,
  DocumentVersionCommitPort,
  RollbackRejectedVersionResult,
  EffectReceiptStore,
} from "../../application/ports";
import { ConcurrentRunUpdateError } from "../../domain/errors";
import { createAgentRun, type AgentRun, type SideEffectReceipt } from "../../domain/model";
import type { AgentLoopCheckpoint } from "../../application/loop";

const fail = (context: string, error: { message: string; code?: string } | null): void => {
  if (error) throw new Error(`${context}: ${error.code ?? "DATABASE_ERROR"}: ${error.message}`);
};

export class SupabaseAgentRunStore implements AgentRunStore {
  constructor(private readonly client: SupabaseClient) {}

  async createForTask(input: { taskId: string; ownerUserId: string; now: string; goal?: string }): Promise<AgentRun> {
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
    // A task owns one conversation/thread. Runs remain immutable execution
    // records, so a later run starts from the prior run's model transcript
    // instead of silently losing the preceding turns.
    const conversation = await this.client.from("conversations")
      .upsert({ task_id: input.taskId, owner_user_id: input.ownerUserId }, { onConflict: "task_id" })
      .select("id")
      .single();
    fail("Unable to create task conversation", conversation.error);
    if (!conversation.data) throw new Error("CONVERSATION_NOT_FOUND");
    const prior = await this.client.from("agent_runs")
      .select("state")
      .eq("task_id", input.taskId)
      .eq("owner_user_id", input.ownerUserId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    fail("Unable to load prior agent run", prior.error);
    const priorCheckpoint = (prior.data?.state as { loopCheckpoint?: AgentLoopCheckpoint } | null)?.loopCheckpoint;
    const run = createAgentRun({
      id: crypto.randomUUID(),
      documentId,
      baseRevision: revision,
      now: input.now,
    });
    const loopCheckpoint: AgentLoopCheckpoint | undefined = priorCheckpoint && !priorCheckpoint.pendingApproval && priorCheckpoint.messages.length
      ? {
          conversationId: conversation.data.id as string,
          messages: structuredClone(priorCheckpoint.messages),
          iterations: 0,
          toolCallCount: 0,
          status: "completed",
          permissionMode: priorCheckpoint.permissionMode,
        }
      : undefined;
    const state = loopCheckpoint ? { ...run, conversationId: conversation.data.id, loopCheckpoint } : { ...run, conversationId: conversation.data.id };
    const created = await this.client.rpc("create_agent_turn", {
      p_task_id: input.taskId,
      p_run_id: run.id,
      p_working_document_id: documentId,
      p_base_revision: revision,
      p_state: state,
      p_goal: input.goal ?? null,
      p_user_message_id: crypto.randomUUID(),
      p_user_message: input.goal ?? "",
    });
    if (created.error?.code === "23505" && created.error.message.includes("agent_runs_one_active_per_task_idx")) {
      throw new Error("CONCURRENT_TURN");
    }
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

  async rollbackRejectedVersion(input: {
    runId: string;
    documentId: string;
    expectedRevision: string;
    idempotencyKey: string;
  }): Promise<RollbackRejectedVersionResult> {
    const result = await this.client.rpc("rollback_rejected_document_version", {
      p_run_id: input.runId,
      p_document_id: input.documentId,
      p_expected_revision: input.expectedRevision,
      p_idempotency_key: input.idempotencyKey,
    });
    fail("Unable to rollback rejected document version", result.error);
    return result.data as RollbackRejectedVersionResult;
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
