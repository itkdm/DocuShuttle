import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentRunStore } from "../../application/ports";
import type { AgentLoopCheckpoint } from "../../application/loop";
import type { AgentRun } from "../../domain/model";
import { logger, measure } from "@/infrastructure/observability";
import type { AgentImageAttachment } from "../../application/message-parts";

const fail = (context: string, error: { message: string; code?: string } | null): void => {
  if (error) throw new Error(`${context}: ${error.code ?? "DATABASE_ERROR"}: ${error.message}`);
};

type RunState = Partial<AgentRun> & { conversationId?: string; loopCheckpoint?: AgentLoopCheckpoint; failure?: AgentRun["failure"] };

/** Owns run creation/loading only; checkpoint persistence belongs to the loop store. */
export class SupabaseAgentRunStore implements AgentRunStore {
  constructor(private readonly client: SupabaseClient) {}

  async createForTask(input: { taskId: string; ownerUserId: string; now: string; goal?: string; clientMessageId?: string; attachments?: readonly AgentImageAttachment[] }): Promise<AgentRun> {
    const runId = crypto.randomUUID();
    const state: RunState = { id: runId, taskId: input.taskId, status: "queued", lockVersion: 0, updatedAt: input.now };
    const created = await measure("db.rpc", { rpc: "create_agent_turn_from_task", operation: "create", table: "agent_runs", taskId: input.taskId }, async () => this.client.rpc("create_agent_turn_from_task", {
      p_task_id: input.taskId,
      p_run_id: runId,
      p_state: state,
      p_goal: input.goal ?? null,
      p_user_message_id: input.clientMessageId ?? crypto.randomUUID(),
      p_user_message: input.goal ?? "",
      p_user_message_parts: [{ type: "text", text: input.goal ?? "" }, ...(input.attachments ?? []).map((image) => ({ type: "image", ...image }))].filter((part) => part.type !== "text" || ("text" in part && part.text !== "")),
    }));
    if (created.error?.code === "23505" && created.error.message.includes("agent_runs_one_active_per_task_idx")) throw new Error("CONCURRENT_TURN");
    if (created.error?.message.includes("TURN_NOT_ALLOWED")) throw new Error("CONCURRENT_TURN");
    fail("Unable to create agent run", created.error);
    const payload = created.data as { run?: unknown; timings?: Record<string, unknown> } | null;
    if (!payload?.run || typeof payload.run !== "object") throw new Error("Invalid create agent turn response");
    logger.info("agent.run.create.phases", { taskId: input.taskId, ...(payload.timings ?? {}) });
    return normalizeRun(payload.run as RunState, input.now);
  }

  async load(runId: string): Promise<AgentRun | null> {
    const result = await this.client.from("agent_runs").select("state, status, lock_version, lease_expires_at, started_at, updated_at, finished_at").eq("id", runId).maybeSingle();
    fail("Unable to load agent run", result.error);
    if (!result.data) return null;
    return normalizeRun({ ...(result.data.state as RunState), id: runId, status: result.data.status, lockVersion: result.data.lock_version, leaseExpiresAt: result.data.lease_expires_at, startedAt: result.data.started_at, updatedAt: result.data.updated_at, completedAt: result.data.finished_at }, result.data.updated_at as string);
  }

}

function normalizeRun(state: RunState, fallbackUpdatedAt: string): AgentRun {
  return {
    id: String(state.id), conversationId: state.conversationId, taskId: state.taskId, documentId: state.documentId,
    baseRevision: state.baseRevision,
    status: state.status ?? "queued",
    pendingInteraction: state.pendingInteraction,
    failure: state.failure,
    lockVersion: Number(state.lockVersion ?? 0),
    leaseExpiresAt: state.leaseExpiresAt, startedAt: state.startedAt, updatedAt: state.updatedAt ?? fallbackUpdatedAt, completedAt: state.completedAt,
  };
}
