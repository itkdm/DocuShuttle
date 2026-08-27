import type { SupabaseClient } from "@supabase/supabase-js";

import { AGENT_LEASE_MANAGED_STATUSES, type AgentLoopCheckpoint, type AgentLoopStore } from "../../application/loop";
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
    const state = { ...row.state, version: nextVersion, status, loopCheckpoint: checkpoint };
    const updated = await this.client
      .from("agent_runs")
      .update({ state, status, resume_cursor: checkpoint, lock_version: nextVersion, updated_at: new Date().toISOString(), lease_expires_at: AGENT_LEASE_MANAGED_STATUSES.includes(status as typeof AGENT_LEASE_MANAGED_STATUSES[number]) ? new Date(Date.now() + 120_000).toISOString() : null })
      .eq("id", runId)
      .eq("lock_version", row.lock_version)
      // The legacy cancel command owns the terminal cancelled state. Never
      // let an in-flight loop write its stale checkpoint back over it.
      .neq("status", "cancelled")
      .select("id")
      .maybeSingle();
    if (updated.error || !updated.data) throw new ConcurrentRunUpdateError(runId);
    await this.persistConversationProjection(runId, checkpoint, row.state);
    await this.persistRunEvents(runId, checkpoint, row.owner_user_id);
  }

  private async persistRunEvents(runId: string, checkpoint: AgentLoopCheckpoint, ownerUserId: string) {
    const events = checkpoint.trace ?? [];
    if (!events.length) return;
    const ids = events.map((event) => event.eventId).filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    const existing = await this.client.from("agent_run_events").select("id").eq("run_id", runId).in("id", ids);
    if (existing.error) throw new Error(`Unable to load persisted agent events: ${existing.error.message}`);
    const known = new Set((existing.data ?? []).map((row) => row.id as string));
    const missing = events.filter((event) => event.eventId && !known.has(event.eventId));
    if (!missing.length) return;
    const last = await this.client.from("agent_run_events").select("sequence").eq("run_id", runId).order("sequence", { ascending: false }).limit(1).maybeSingle();
    if (last.error) throw new Error(`Unable to load agent event cursor: ${last.error.message}`);
    const start = Number(last.data?.sequence ?? 0);
    const rows = missing.map((event, index) => ({
      id: event.eventId as string,
      owner_user_id: ownerUserId,
      run_id: runId,
      sequence: start + index + 1,
      event,
      occurred_at: event.timestamp ?? new Date().toISOString(),
    }));
    const inserted = await this.client.from("agent_run_events").insert(rows);
    if (inserted.error && inserted.error.code !== "23505") throw new Error(`Unable to persist agent events: ${inserted.error.message}`);
  }

  /** Persist semantic assistant/tool messages once; replaying a checkpoint is
   * idempotent and never makes the durable conversation depend on compaction. */
  private async persistConversationProjection(runId: string, checkpoint: AgentLoopCheckpoint, state: Record<string, unknown>) {
    const conversationId = checkpoint.conversationId ?? (state.conversationId as string | undefined);
    if (!conversationId) return;
    const owner = await this.client.from("conversations").select("owner_user_id").eq("id", conversationId).maybeSingle();
    if (owner.error || !owner.data) return;
    const ownerId = owner.data.owner_user_id as string;
    const messages = checkpoint.messages.filter((message) => message.role === "assistant" || message.role === "tool");
    if (!messages.length) return;
    const rows = messages.map((message, index) => {
      const callId = message.toolCallId ?? message.toolCalls?.[0]?.id;
      const key = `${runId}:${message.role}:${callId ?? index}`;
      return {
        owner_user_id: ownerId,
        conversation_id: conversationId,
        turn_id: runId,
        role: message.role,
        parts: [{ type: "text", text: message.content, ...(callId ? { toolCallId: callId, toolName: message.toolName } : {}), ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}) }],
        run_id: runId,
        message_key: key,
      };
    });
    const result = await this.client.from("messages").upsert(rows, { onConflict: "conversation_id,message_key", ignoreDuplicates: true });
    if (result.error) throw new Error(`Unable to persist conversation messages: ${result.error.message}`);
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
