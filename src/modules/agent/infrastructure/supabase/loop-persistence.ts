import type { SupabaseClient } from "@supabase/supabase-js";

import { AGENT_LEASE_MANAGED_STATUSES, normalizeAgentLoopCheckpoint, type AgentEffectReceipt, type AgentLoopCheckpoint, type AgentLoopMessage, type AgentLoopStore } from "../../application/loop";
import type { AgentConversationContext } from "../../application/ports";
import { createAgentEvent, type AgentEvent } from "../../application/events";
import { ConcurrentRunUpdateError } from "../../domain/errors";
import { logger, measure } from "@/infrastructure/observability";
import type { AgentImageAttachment } from "../../application/message-parts";
import { describeAgentImages, imagePartsFromMessageParts, textFromAgentMessageParts, normalizeAgentMessageParts } from "../../application/message-parts";

export type SupabaseAgentLoopBootstrap = {
  runId: string;
  taskId: string;
  lockVersion: number;
  checkpoint?: AgentLoopCheckpoint;
  conversationId?: string;
  context: AgentConversationContext;
};

/** Optimistic checkpoint storage nested in the existing agent run state. */
export class SupabaseAgentLoopStore implements AgentLoopStore {
  private readonly versions = new Map<string, number>();

  constructor(private readonly client: SupabaseClient, private bootstrap?: SupabaseAgentLoopBootstrap) {}

  async loadBootstrap(runId: string): Promise<SupabaseAgentLoopBootstrap> {
    return measure("agent.loop.bootstrap", { runId, operation: "rpc", rpc: "load_agent_loop_bootstrap" }, async () => {
      const result = await this.client.rpc("load_agent_loop_bootstrap", { p_run_id: runId });
      if (result.error) throw new Error(`Unable to load agent loop bootstrap: ${result.error.message}`);
      const payload = result.data as Record<string, unknown> | null;
      const context = payload?.priorMessages;
      if (!payload || typeof payload.taskId !== "string" || typeof payload.lockVersion !== "number" || !Array.isArray(context)) {
        throw new Error("Invalid agent loop bootstrap response");
      }
      const checkpoint = normalizeAgentLoopCheckpoint(payload.checkpoint);
      return {
        runId,
        taskId: payload.taskId,
        lockVersion: payload.lockVersion,
        checkpoint,
        conversationId: typeof payload.conversationId === "string" ? payload.conversationId : undefined,
        context: {
          conversationId: typeof payload.conversationId === "string" ? payload.conversationId : undefined,
          messages: context.flatMap((message): AgentLoopMessage[] => {
            if (!message || typeof message !== "object" || ((message as { role?: unknown }).role !== "user" && (message as { role?: unknown }).role !== "assistant")) return [];
            const item = message as { role: "user" | "assistant"; parts?: unknown; content?: unknown };
            if (Array.isArray(item.parts)) { const parts = normalizeAgentMessageParts(item.parts); const content = `${textFromAgentMessageParts(parts).trim()}${describeAgentImages(imagePartsFromMessageParts(parts))}`; return content ? [{ role: item.role, content }] : []; }
            return typeof item.content === "string" && item.content ? [{ role: item.role, content: item.content }] : [];
          }),
          loadedCount: typeof payload.loadedCount === "number" ? payload.loadedCount : context.length,
          truncated: payload.truncated === true,
          limit: 200,
        },
      };
    });
  }

  async load(runId: string): Promise<AgentLoopCheckpoint | undefined> {
    return measure("agent.checkpoint.load", { runId, table: "agent_runs", operation: "select" }, async () => {
      if (this.bootstrap?.runId === runId) {
        const checkpoint = this.bootstrap.checkpoint;
        const lockVersion = this.bootstrap.lockVersion;
        this.bootstrap = undefined;
        this.versions.set(runId, lockVersion);
        return checkpoint;
      }
      const result = await this.client.from("agent_runs").select("state, lock_version").eq("id", runId).maybeSingle();
      if (result.error) throw new Error(`Unable to load agent loop checkpoint: ${result.error.message}`);
      if (result.data && !this.versions.has(runId)) this.versions.set(runId, result.data.lock_version);
      const state = result.data?.state as Record<string, unknown> | undefined;
      return normalizeAgentLoopCheckpoint(state?.loopCheckpoint);
    });
  }

  getOwnedLockVersion(runId: string): number | undefined {
    return this.versions.get(runId);
  }

  async save(runId: string, checkpoint: AgentLoopCheckpoint): Promise<void> {
    return measure("agent.checkpoint.save", { runId, table: "agent_runs", operation: "checkpoint_and_projection", checkpointStatus: checkpoint.status }, async () => this.saveInternal(runId, checkpoint));
  }

  async saveWithAssistantMessage(runId: string, checkpoint: AgentLoopCheckpoint, message: { messageKey: string; text: string }): Promise<void> {
    return measure("agent.checkpoint.save_with_message", { runId, table: "agent_runs", operation: "checkpoint_and_assistant_message", checkpointStatus: checkpoint.status }, async () => {
      const expectedVersion = this.versions.get(runId);
      if (expectedVersion === undefined) throw new ConcurrentRunUpdateError(runId);
      const result = await this.client.rpc("commit_agent_checkpoint_with_message", {
        p_run_id: runId,
        p_expected_lock_version: expectedVersion,
        p_checkpoint: checkpoint,
        p_message_key: message.messageKey,
        p_message_text: message.text,
      });
      if (result.error) throw new Error(`Unable to persist checkpoint and assistant message: ${result.error.message}`);
      const payload = result.data as { checkpoint?: unknown; lockVersion?: unknown } | null;
      if (!payload || typeof payload.lockVersion !== "number" || !Number.isInteger(payload.lockVersion) || payload.lockVersion < 0 || !payload.checkpoint) {
        throw new Error("Invalid checkpoint/message commit response");
      }
      this.versions.set(runId, payload.lockVersion);
    });
  }

  private async saveInternal(runId: string, checkpoint: AgentLoopCheckpoint): Promise<void> {
    const expectedVersion = this.versions.get(runId);
    if (expectedVersion === undefined) throw new ConcurrentRunUpdateError(runId);
    const result = await this.client.rpc("save_agent_loop_checkpoint", {
      p_run_id: runId,
      p_expected_lock_version: expectedVersion,
      p_checkpoint: checkpoint,
    });
    if (result.error) {
      if (result.error.message.includes("RUN_VERSION_CONFLICT") || result.error.message.includes("RUN_CANCELLED")) throw new ConcurrentRunUpdateError(runId);
      throw new Error(`Unable to save agent loop checkpoint: ${result.error.message}`);
    }
    const payload = result.data as { lockVersion?: unknown } | null;
    if (!payload || typeof payload.lockVersion !== "number" || !Number.isInteger(payload.lockVersion) || payload.lockVersion < 0) throw new Error("Invalid checkpoint save response");
    this.versions.set(runId, payload.lockVersion);
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

  async appendUserMessage(runId: string, message: { id: string; text: string; images?: readonly AgentImageAttachment[] }): Promise<void> {
    const run = await this.client.from("agent_runs").select("state, owner_user_id").eq("id", runId).maybeSingle();
    if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
    const state = run.data.state as { conversationId?: string };
    if (!state.conversationId) return;
    const result = await this.client.from("messages").upsert({
      id: message.id, owner_user_id: run.data.owner_user_id, conversation_id: state.conversationId,
      role: "user", parts: [{ type: "text", text: message.text }, ...(message.images ?? []).map((image) => ({ type: "image", ...image }))].filter((part) => part.type !== "text" || ("text" in part && part.text !== "")), run_id: runId,
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
    const expectedVersion = this.versions.get(runId);
    if (expectedVersion === undefined) throw new ConcurrentRunUpdateError(runId);
    const result = await this.client.rpc("save_effect_receipt", {
      p_run_id: runId,
      p_expected_lock_version: expectedVersion,
      p_receipt: { ...receipt, stepId: receipt.callId, effect: receipt.toolName },
    });
    if (result.error) {
      if (result.error.message.includes("RUN_VERSION_CONFLICT")) throw new ConcurrentRunUpdateError(runId);
      throw new Error(`Unable to save effect receipt: ${result.error.message}`);
    }
    const payload = result.data as { receipt?: unknown; lockVersion?: unknown } | null;
    if (!payload || !payload.receipt || payload.lockVersion !== expectedVersion) {
      throw new Error("Invalid effect receipt response");
    }
    this.versions.set(runId, expectedVersion);
    return payload.receipt as AgentEffectReceipt;
  }

  async heartbeat(runId: string): Promise<boolean> {
    return measure("agent.checkpoint.heartbeat", { runId, table: "agent_runs", operation: "lease_update" }, async () => {
      const result = await this.client.from("agent_runs").update({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() }).eq("id", runId).in("status", [...AGENT_LEASE_MANAGED_STATUSES]).select("id").maybeSingle();
      if (result.error) return false;
      return Boolean(result.data);
    });
  }

  async claimRecovery(runId: string): Promise<AgentLoopCheckpoint | undefined> {
    const result = await this.client.rpc("claim_agent_run_recovery", { p_run_id: runId });
    if (result.error) {
      if (result.error.message.includes("RUN_STILL_ACTIVE")) throw new Error("RUN_STILL_ACTIVE");
      throw new Error(`Unable to claim agent recovery: ${result.error.message}`);
    }
    const payload = result.data as { checkpoint?: unknown; lockVersion?: number } | null;
    if (payload?.lockVersion !== undefined) this.versions.set(runId, payload.lockVersion);
    return normalizeAgentLoopCheckpoint(payload?.checkpoint ?? result.data);
  }

  async releaseLeaseForRecovery(runId: string): Promise<void> {
    const result = await this.client.rpc("release_agent_run_recovery_lease", { p_run_id: runId });
    if (result.error) throw new Error(`Unable to release agent recovery lease: ${result.error.message}`);
  }

  async markCancelled(runId: string): Promise<void> {
    const current = await this.client.from("agent_runs").select("state, lock_version, status").eq("id", runId).maybeSingle();
    if (current.error || !current.data) throw new Error("RUN_NOT_FOUND");
    const ownedVersion = this.versions.get(runId);
    if (ownedVersion !== undefined && ownedVersion !== current.data.lock_version) throw new ConcurrentRunUpdateError(runId);
    const expectedVersion = ownedVersion ?? current.data.lock_version;
    this.versions.set(runId, expectedVersion);
    const state = (current.data.state ?? {}) as Record<string, unknown>;
    const checkpoint = state.loopCheckpoint as AgentLoopCheckpoint | undefined;
    if (!checkpoint) {
      const updated = await this.client.from("agent_runs")
        .update({ state: { ...state, status: "cancelled", pendingInteraction: null, pendingResolution: null }, status: "cancelled", resume_cursor: {}, lock_version: expectedVersion + 1, updated_at: new Date().toISOString(), lease_expires_at: null })
        .eq("id", runId).eq("lock_version", expectedVersion).select("id").maybeSingle();
      if (updated.error || !updated.data) throw new ConcurrentRunUpdateError(runId);
      this.versions.set(runId, expectedVersion + 1);
      return;
    }
    if (checkpoint.status === "cancelled") return;
    const event = createAgentEvent(runId, { type: "turn.cancelled", text: "本轮操作已取消。" });
    const checkpointWithoutTrace = normalizeAgentLoopCheckpoint(checkpoint)!;
    const nextCheckpoint: AgentLoopCheckpoint = { ...checkpointWithoutTrace, status: "cancelled", pendingInteraction: undefined, pendingResolution: undefined, finalText: event.text };
    const nextState = { ...state, status: "cancelled", pendingInteraction: null, pendingResolution: null, loopCheckpoint: nextCheckpoint, version: expectedVersion + 1 };
    const updated = await this.client.from("agent_runs")
      .update({ state: nextState, status: "cancelled", resume_cursor: nextCheckpoint, lock_version: expectedVersion + 1, updated_at: new Date().toISOString() })
      .eq("id", runId).eq("lock_version", expectedVersion).select("id").maybeSingle();
    if (updated.error || !updated.data) throw new ConcurrentRunUpdateError(runId);
    this.versions.set(runId, expectedVersion + 1);
    try {
      await this.appendEvents(runId, [event]);
    } catch {
      logger.error("agent.event.persist_failed", { runId, eventId: event.eventId, eventType: event.type });
    }
  }

  async resolvePendingApproval(runId: string, interactionId: string, callId: string, decision: "approved" | "rejected"): Promise<AgentLoopCheckpoint | undefined> {
    return this.resolvePendingInteraction(runId, interactionId, "approval", { callId, decision });
  }

  async resolvePendingUserInput(runId: string, interactionId: string, message: { id: string; text: string; images?: readonly AgentImageAttachment[] }): Promise<AgentLoopCheckpoint | undefined> {
    return this.resolvePendingInteraction(runId, interactionId, "user_input", message);
  }

  private async resolvePendingInteraction(runId: string, interactionId: string, interactionType: "approval" | "user_input", resolution: { callId: string; decision: "approved" | "rejected" } | { id: string; text: string; images?: readonly AgentImageAttachment[] }): Promise<AgentLoopCheckpoint | undefined> {
    return measure("agent.interaction.resolve", { runId, interactionId, interactionType, operation: "rpc", rpc: "resolve_agent_loop_interaction" }, async () => {
      const result = await this.client.rpc("resolve_agent_loop_interaction", {
        p_run_id: runId,
        p_interaction_id: interactionId,
        p_interaction_type: interactionType,
        p_call_id: "callId" in resolution ? resolution.callId : null,
        p_resolution: "callId" in resolution
          ? { interactionId, type: "approval", callId: resolution.callId, decision: resolution.decision }
          : { interactionId, type: "user_input", messageId: resolution.id, text: resolution.text, ...(resolution.images?.length ? { images: resolution.images } : {}) },
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
      const payload = result.data as { checkpoint?: unknown; lockVersion?: number } | null;
      if (payload?.lockVersion !== undefined) this.versions.set(runId, payload.lockVersion);
      return normalizeAgentLoopCheckpoint(payload?.checkpoint ?? result.data);
    });
  }
}
