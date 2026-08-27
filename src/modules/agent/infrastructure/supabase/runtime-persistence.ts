import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentRunStore } from "../../application/ports";
import type { AgentLoopCheckpoint } from "../../application/loop";
import type { AgentRun } from "../../domain/model";
import { measure } from "@/infrastructure/observability";

const fail = (context: string, error: { message: string; code?: string } | null): void => {
  if (error) throw new Error(`${context}: ${error.code ?? "DATABASE_ERROR"}: ${error.message}`);
};

type RunState = Partial<AgentRun> & { conversationId?: string; loopCheckpoint?: AgentLoopCheckpoint; failure?: AgentRun["failure"] };

/** Owns run creation/loading only; checkpoint persistence belongs to the loop store. */
export class SupabaseAgentRunStore implements AgentRunStore {
  constructor(private readonly client: SupabaseClient) {}

  async createForTask(input: { taskId: string; ownerUserId: string; now: string; goal?: string; clientMessageId?: string }): Promise<AgentRun> {
    const document = await this.client.from("working_documents").select("id").eq("task_id", input.taskId).eq("owner_user_id", input.ownerUserId).single();
    fail("Unable to load working document", document.error);
    if (!document.data) throw new Error("WORKING_DOCUMENT_NOT_FOUND");
    const documentId = document.data.id as string;
    const revision = await this.currentRevision(documentId);
    const runId = crypto.randomUUID();
    const state: RunState = { id: runId, taskId: input.taskId, documentId, baseRevision: revision, status: "queued", lockVersion: 0, updatedAt: input.now };
    const created = await measure("db.rpc", { rpc: "create_agent_turn", operation: "create", table: "agent_runs", taskId: input.taskId }, async () => this.client.rpc("create_agent_turn", {
      p_task_id: input.taskId,
      p_run_id: runId,
      p_working_document_id: documentId,
      p_base_revision: revision,
      p_state: state,
      p_goal: input.goal ?? null,
      p_user_message_id: input.clientMessageId ?? crypto.randomUUID(),
      p_user_message: input.goal ?? "",
    }));
    if (created.error?.code === "23505" && created.error.message.includes("agent_runs_one_active_per_task_idx")) throw new Error("CONCURRENT_TURN");
    fail("Unable to create agent run", created.error);
    return normalizeRun((created.data ?? state) as RunState, input.now);
  }

  async load(runId: string): Promise<AgentRun | null> {
    const result = await this.client.from("agent_runs").select("state, status, lock_version, lease_expires_at, started_at, updated_at, finished_at").eq("id", runId).maybeSingle();
    fail("Unable to load agent run", result.error);
    if (!result.data) return null;
    return normalizeRun({ ...(result.data.state as RunState), id: runId, status: result.data.status, lockVersion: result.data.lock_version, leaseExpiresAt: result.data.lease_expires_at, startedAt: result.data.started_at, updatedAt: result.data.updated_at, completedAt: result.data.finished_at }, result.data.updated_at as string);
  }

  private async currentRevision(documentId: string): Promise<string> {
    const result = await this.client.rpc("get_current_document_revision", { p_document_id: documentId });
    fail("Unable to load document revision", result.error);
    if (typeof result.data !== "string" || !result.data) throw new Error("DOCUMENT_REVISION_NOT_FOUND");
    return result.data;
  }
}

function normalizeRun(state: RunState, fallbackUpdatedAt: string): AgentRun {
  return {
    id: String(state.id), conversationId: state.conversationId, taskId: state.taskId, documentId: state.documentId,
    baseRevision: state.baseRevision,
    status: state.status ?? "queued",
    pendingInteraction: state.pendingInteraction ?? (state.loopCheckpoint?.pendingApproval
      ? { type: "approval", callId: state.loopCheckpoint.pendingApproval.callId, toolName: state.loopCheckpoint.pendingApproval.name, input: state.loopCheckpoint.pendingApproval.input }
      : state.loopCheckpoint?.pendingUserQuestion ? { type: "user_input", question: state.loopCheckpoint.pendingUserQuestion.text } : undefined),
    failure: state.failure,
    lockVersion: Number(state.lockVersion ?? 0),
    leaseExpiresAt: state.leaseExpiresAt, startedAt: state.startedAt, updatedAt: state.updatedAt ?? fallbackUpdatedAt, completedAt: state.completedAt,
  };
}
