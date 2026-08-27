import type { SupabaseClient } from "@supabase/supabase-js";

import { AGENT_LEASE_MANAGED_STATUSES, type AgentLoopCheckpoint, type AgentLoopEvent, type AgentLoopStore } from "../../application/loop";
import { ConcurrentRunUpdateError } from "../../domain/errors";
import { measure } from "@/infrastructure/observability";

type RunRow = { state: Record<string, unknown>; lock_version: number; owner_user_id: string };

/** Optimistic checkpoint storage nested in the existing agent run state. */
export class SupabaseAgentLoopStore implements AgentLoopStore {
  constructor(private readonly client: SupabaseClient) {}

  async load(runId: string): Promise<AgentLoopCheckpoint | undefined> {
    return measure("agent.checkpoint.load", { runId, table: "agent_runs", operation: "select" }, async () => {
      const result = await this.client.from("agent_runs").select("state").eq("id", runId).maybeSingle();
      if (result.error) throw new Error(`Unable to load agent loop checkpoint: ${result.error.message}`);
      const state = result.data?.state as Record<string, unknown> | undefined;
      return state?.loopCheckpoint as AgentLoopCheckpoint | undefined;
    });
  }

  async save(runId: string, checkpoint: AgentLoopCheckpoint): Promise<void> {
    return measure("agent.checkpoint.save", { runId, table: "agent_runs", operation: "checkpoint_and_projection", checkpointStatus: checkpoint.status }, async () => this.saveInternal(runId, checkpoint));
  }

  private async saveInternal(runId: string, checkpoint: AgentLoopCheckpoint): Promise<void> {
    const current = await this.client.from("agent_runs").select("state, lock_version, owner_user_id").eq("id", runId).maybeSingle();
    if (current.error || !current.data) throw new Error("RUN_NOT_FOUND");
    const row = current.data as RunRow;
    const nextVersion = row.lock_version + 1;
    const status = checkpoint.status === "completed"
      ? "completed"
      : checkpoint.status === "failed"
        ? "failed"
        : checkpoint.status === "cancelled"
          ? "cancelled"
          : checkpoint.pendingApproval
            ? "awaiting_approval"
            : checkpoint.pendingUserQuestion
              ? "awaiting_user"
              : "running";
    const state = {
      ...row.state,
      version: nextVersion,
      status,
      loopCheckpoint: checkpoint,
      pendingInteraction: checkpoint.pendingApproval
        ? { type: "approval", callId: checkpoint.pendingApproval.callId, toolName: checkpoint.pendingApproval.name, input: checkpoint.pendingApproval.input }
        : checkpoint.pendingUserQuestion ? { type: "user_input", question: checkpoint.pendingUserQuestion.text } : undefined,
      failure: checkpoint.status === "failed" ? { code: "AGENT_LOOP_FAILED", message: checkpoint.finalText ?? "Agent execution failed", retryable: true } : undefined,
    };
    const updated = await this.client
      .from("agent_runs")
      .update({ state, status, resume_cursor: checkpoint, lock_version: nextVersion, updated_at: new Date().toISOString(), lease_expires_at: AGENT_LEASE_MANAGED_STATUSES.includes(status as typeof AGENT_LEASE_MANAGED_STATUSES[number]) ? new Date(Date.now() + 120_000).toISOString() : null })
      .eq("id", runId)
      .eq("lock_version", row.lock_version)
      // Cancellation owns the terminal state. Never let an in-flight loop
      // write its stale checkpoint back over it.
      .neq("status", "cancelled")
      .select("id")
      .maybeSingle();
    if (updated.error || !updated.data) throw new ConcurrentRunUpdateError(runId);
  }

  async appendEvents(runId: string, events: readonly AgentLoopEvent[]): Promise<void> {
    if (!events.length) return;
    const result = await this.client.rpc("append_agent_events", { p_run_id: runId, p_events: events });
    if (result.error) throw new Error(`Unable to persist agent events: ${result.error.message}`);
  }

  async appendAssistantMessage(runId: string, message: { id: string; text: string }): Promise<void> {
    const run = await this.client.from("agent_runs").select("state, owner_user_id").eq("id", runId).maybeSingle();
    if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
    const state = run.data.state as { conversationId?: string };
    if (!state.conversationId) return;
    const result = await this.client.from("messages").upsert({
      id: crypto.randomUUID(), owner_user_id: run.data.owner_user_id, conversation_id: state.conversationId,
      role: "assistant", parts: [{ type: "text", text: message.text }], run_id: runId,
      message_key: `assistant:${message.id}`, delivery_status: "sent",
    }, { onConflict: "conversation_id,message_key", ignoreDuplicates: true });
    if (result.error) throw new Error(`Unable to persist assistant message: ${result.error.message}`);
  }

  async heartbeat(runId: string): Promise<boolean> {
    return measure("agent.checkpoint.heartbeat", { runId, table: "agent_runs", operation: "lease_update" }, async () => {
      const result = await this.client.from("agent_runs").update({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() }).eq("id", runId).in("status", [...AGENT_LEASE_MANAGED_STATUSES]).select("id").maybeSingle();
      if (result.error) return false;
      return Boolean(result.data);
    });
  }

  async markCancelled(runId: string): Promise<void> {
    const current = await this.client.from("agent_runs").select("state, lock_version, status").eq("id", runId).maybeSingle();
    if (current.error || !current.data) throw new Error("RUN_NOT_FOUND");
    const state = (current.data.state ?? {}) as Record<string, unknown>;
    const checkpoint = state.loopCheckpoint as AgentLoopCheckpoint | undefined;
    if (!checkpoint || checkpoint.status === "cancelled") return;
    const event = { type: "turn.cancelled", text: "本轮操作已取消。", eventId: crypto.randomUUID(), timestamp: new Date().toISOString() } as const;
    const nextCheckpoint: AgentLoopCheckpoint = { ...checkpoint, status: "cancelled", pendingApproval: undefined, finalText: event.text, trace: [...(checkpoint.trace ?? []), event].slice(-200) };
    const nextState = { ...state, status: "cancelled", loopCheckpoint: nextCheckpoint, version: current.data.lock_version + 1 };
    const updated = await this.client.from("agent_runs")
      .update({ state: nextState, status: "cancelled", resume_cursor: nextCheckpoint, lock_version: current.data.lock_version + 1, updated_at: new Date().toISOString() })
      .eq("id", runId).eq("lock_version", current.data.lock_version).select("id").maybeSingle();
    if (updated.error || !updated.data) throw new ConcurrentRunUpdateError(runId);
  }

  async claimPendingApproval(runId: string, callId: string): Promise<AgentLoopCheckpoint | undefined> {
    return measure("agent.approval.claim", { runId, callId, operation: "rpc", rpc: "claim_agent_loop_approval" }, async () => {
      const result = await this.client.rpc("claim_agent_loop_approval", { p_run_id: runId, p_call_id: callId });
      if (result.error) {
        if (result.error.message.includes("APPROVAL_ALREADY_CLAIMED")) return undefined;
        throw new Error(`Unable to claim agent approval: ${result.error.message}`);
      }
      return (result.data ?? undefined) as AgentLoopCheckpoint | undefined;
    });
  }
}
