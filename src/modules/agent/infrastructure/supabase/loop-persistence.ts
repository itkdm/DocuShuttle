import type { SupabaseClient } from "@supabase/supabase-js";

import { AGENT_LEASE_MANAGED_STATUSES, type AgentEffectReceipt, type AgentLoopCheckpoint, type AgentLoopStore } from "../../application/loop";
import { createAgentEvent, type AgentEvent } from "../../application/events";
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
    const status = ["completed", "failed", "cancelled"].includes(checkpoint.status)
      ? checkpoint.status
      : checkpoint.status === "awaiting_approval"
        ? "awaiting_approval"
        : checkpoint.status === "awaiting_user"
          ? "awaiting_user"
          : "running";
    const state = {
      ...row.state,
      version: nextVersion,
      status,
      loopCheckpoint: checkpoint,
      pendingInteraction: checkpoint.pendingInteraction ?? null,
      pendingResolution: checkpoint.pendingResolution ?? null,
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

  async appendEvents(runId: string, events: readonly AgentEvent[]): Promise<void> {
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

  async appendUserMessage(runId: string, message: { id: string; text: string }): Promise<void> {
    const run = await this.client.from("agent_runs").select("state, owner_user_id").eq("id", runId).maybeSingle();
    if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
    const state = run.data.state as { conversationId?: string };
    if (!state.conversationId) return;
    const result = await this.client.from("messages").upsert({
      id: message.id, owner_user_id: run.data.owner_user_id, conversation_id: state.conversationId,
      role: "user", parts: [{ type: "text", text: message.text }], run_id: runId,
      message_key: message.id, delivery_status: "sent",
    }, { onConflict: "conversation_id,message_key", ignoreDuplicates: true });
    if (result.error) throw new Error(`Unable to persist user message: ${result.error.message}`);
  }

  async loadEffectReceipt(runId: string, idempotencyKey: string): Promise<AgentEffectReceipt | undefined> {
    const result = await this.client.from("agent_effect_receipts").select("receipt").eq("run_id", runId).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (result.error) throw new Error(`Unable to load effect receipt: ${result.error.message}`);
    return (result.data?.receipt ?? undefined) as AgentEffectReceipt | undefined;
  }

  async saveEffectReceipt(runId: string, receipt: AgentEffectReceipt): Promise<AgentEffectReceipt> {
    const result = await this.client.rpc("save_effect_receipt", {
      p_run_id: runId,
      p_receipt: { ...receipt, stepId: receipt.callId, effect: receipt.toolName },
    });
    if (result.error) throw new Error(`Unable to save effect receipt: ${result.error.message}`);
    return (result.data ?? receipt) as AgentEffectReceipt;
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
    if (!checkpoint) {
      const updated = await this.client.from("agent_runs")
        .update({ state: { ...state, status: "cancelled", pendingInteraction: null, pendingResolution: null }, status: "cancelled", resume_cursor: {}, lock_version: current.data.lock_version + 1, updated_at: new Date().toISOString(), lease_expires_at: null })
        .eq("id", runId).eq("lock_version", current.data.lock_version).select("id").maybeSingle();
      if (updated.error || !updated.data) throw new ConcurrentRunUpdateError(runId);
      return;
    }
    if (checkpoint.status === "cancelled") return;
    const event = createAgentEvent(runId, { type: "turn.cancelled", text: "本轮操作已取消。" });
    const nextCheckpoint: AgentLoopCheckpoint = { ...checkpoint, status: "cancelled", pendingInteraction: undefined, finalText: event.text, trace: [...(checkpoint.trace ?? []), event].slice(-200) };
    const nextState = { ...state, status: "cancelled", pendingInteraction: null, pendingResolution: null, loopCheckpoint: nextCheckpoint, version: current.data.lock_version + 1 };
    const updated = await this.client.from("agent_runs")
      .update({ state: nextState, status: "cancelled", resume_cursor: nextCheckpoint, lock_version: current.data.lock_version + 1, updated_at: new Date().toISOString() })
      .eq("id", runId).eq("lock_version", current.data.lock_version).select("id").maybeSingle();
    if (updated.error || !updated.data) throw new ConcurrentRunUpdateError(runId);
    await this.appendEvents(runId, [event]);
  }

  async resolvePendingApproval(runId: string, interactionId: string, callId: string, decision: "approved" | "rejected"): Promise<AgentLoopCheckpoint | undefined> {
    return this.resolvePendingInteraction(runId, interactionId, "approval", { callId, decision });
  }

  async resolvePendingUserInput(runId: string, interactionId: string, message: { id: string; text: string }): Promise<AgentLoopCheckpoint | undefined> {
    return this.resolvePendingInteraction(runId, interactionId, "user_input", message);
  }

  private async resolvePendingInteraction(runId: string, interactionId: string, interactionType: "approval" | "user_input", resolution: { callId: string; decision: "approved" | "rejected" } | { id: string; text: string }): Promise<AgentLoopCheckpoint | undefined> {
    return measure("agent.interaction.resolve", { runId, interactionId, interactionType, operation: "rpc", rpc: "resolve_agent_loop_interaction" }, async () => {
      const result = await this.client.rpc("resolve_agent_loop_interaction", {
        p_run_id: runId,
        p_interaction_id: interactionId,
        p_interaction_type: interactionType,
        p_call_id: "callId" in resolution ? resolution.callId : null,
        p_resolution: "callId" in resolution
          ? { interactionId, type: "approval", callId: resolution.callId, decision: resolution.decision }
          : { interactionId, type: "user_input", messageId: resolution.id, text: resolution.text },
      });
      if (result.error) {
        if (result.error.message.includes("INTERACTION_ALREADY_CLAIMED")) return undefined;
        if (result.error.message.includes("INTERACTION_MISMATCH")) {
          throw new Error(
            interactionType === "approval"
              ? "APPROVAL_INTERACTION_MISMATCH"
              : "USER_INPUT_INTERACTION_MISMATCH"
          );
        }
        throw new Error(`Unable to claim agent interaction: ${result.error.message}`);
      }
      return (result.data ?? undefined) as AgentLoopCheckpoint | undefined;
    });
  }
}
