import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentLoopCheckpoint, AgentLoopStore } from "../../application/loop";
import { ConcurrentRunUpdateError } from "../../domain/errors";

type RunRow = { state: Record<string, unknown>; lock_version: number };

/** Optimistic checkpoint storage nested in the existing agent run state. */
export class SupabaseAgentLoopStore implements AgentLoopStore {
  constructor(private readonly client: SupabaseClient) {}

  async load(runId: string): Promise<AgentLoopCheckpoint | undefined> {
    const result = await this.client.from("agent_runs").select("state").eq("id", runId).maybeSingle();
    if (result.error) throw new Error(`Unable to load agent loop checkpoint: ${result.error.message}`);
    const state = result.data?.state as Record<string, unknown> | undefined;
    return state?.loopCheckpoint as AgentLoopCheckpoint | undefined;
  }

  async save(runId: string, checkpoint: AgentLoopCheckpoint): Promise<void> {
    const current = await this.client.from("agent_runs").select("state, lock_version").eq("id", runId).maybeSingle();
    if (current.error || !current.data) throw new Error("RUN_NOT_FOUND");
    const row = current.data as RunRow;
    const nextVersion = row.lock_version + 1;
    const status = checkpoint.status === "completed"
      ? "completed"
      : checkpoint.status === "failed"
        ? "failed"
        : checkpoint.status === "awaiting_user"
          ? "awaiting_scope_confirmation"
          : "analyzing";
    const state = { ...row.state, version: nextVersion, status, loopCheckpoint: checkpoint };
    const updated = await this.client
      .from("agent_runs")
      .update({ state, status, resume_cursor: checkpoint, lock_version: nextVersion, updated_at: new Date().toISOString() })
      .eq("id", runId)
      .eq("lock_version", row.lock_version)
      // The legacy cancel command owns the terminal cancelled state. Never
      // let an in-flight loop write its stale checkpoint back over it.
      .neq("status", "cancelled")
      .select("id")
      .maybeSingle();
    if (updated.error || !updated.data) throw new ConcurrentRunUpdateError(runId);
  }

  async claimPendingApproval(runId: string, callId: string): Promise<AgentLoopCheckpoint | undefined> {
    const result = await this.client.rpc("claim_agent_loop_approval", { p_run_id: runId, p_call_id: callId });
    if (result.error) {
      if (result.error.message.includes("APPROVAL_ALREADY_CLAIMED")) return undefined;
      throw new Error(`Unable to claim agent approval: ${result.error.message}`);
    }
    return (result.data ?? undefined) as AgentLoopCheckpoint | undefined;
  }
}
