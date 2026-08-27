import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { SupabaseAgentLoopStore } from "./loop-persistence";

describe("SupabaseAgentLoopStore interaction resolution contract", () => {
  it("sends only the approval decision and relies on the RPC for canonical tool data", async () => {
    const checkpoint = {
      messages: [{ role: "assistant" as const, content: "", toolCalls: [{ id: "call-1", name: "apply_change", input: { nodeId: "p-1" } }] }],
      iterations: 1,
      toolCallCount: 1,
      status: "running" as const,
      pendingResolution: {
        interactionId: "interaction-1",
        type: "approval" as const,
        callId: "call-1",
        toolName: "apply_change",
        input: { nodeId: "p-1" },
        decision: "approved" as const,
      },
    };
    const rpc = vi.fn().mockResolvedValue({ data: { ...checkpoint, trace: [{ type: "model.started" }] }, error: null });
    const store = new SupabaseAgentLoopStore({ rpc } as unknown as SupabaseClient);

    await expect(store.resolvePendingApproval("run-1", "interaction-1", "call-1", "approved")).resolves.toEqual(checkpoint);
    expect(rpc).toHaveBeenCalledWith("resolve_agent_loop_interaction", {
      p_run_id: "run-1",
      p_interaction_id: "interaction-1",
      p_interaction_type: "approval",
      p_call_id: "call-1",
      p_resolution: { interactionId: "interaction-1", type: "approval", callId: "call-1", decision: "approved" },
    });
    expect(rpc.mock.calls[0][1].p_resolution).not.toHaveProperty("toolName");
    expect(rpc.mock.calls[0][1].p_resolution).not.toHaveProperty("input");
  });

  it("keeps user-input message identity in the resolution RPC payload", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "running", trace: [{ type: "model.started" }] }, error: null });
    const store = new SupabaseAgentLoopStore({ rpc } as unknown as SupabaseClient);

    const result = await store.resolvePendingUserInput("run-2", "interaction-2", { id: "message-2", text: "第三章" });
    expect(result && "trace" in result).toBe(false);
    expect(rpc).toHaveBeenCalledWith("resolve_agent_loop_interaction", expect.objectContaining({
      p_interaction_type: "user_input",
      p_resolution: { interactionId: "interaction-2", type: "user_input", messageId: "message-2", text: "第三章" },
    }));
  });

  it("clears both checkpoint and projection resolution fields when cancelling", async () => {
    const current = {
      state: {
        loopCheckpoint: {
          messages: [], iterations: 1, toolCallCount: 1, status: "running",
          pendingResolution: { interactionId: "interaction-3", type: "approval", callId: "call-3", toolName: "apply_change", input: {}, decision: "approved" },
        },
      },
      lock_version: 4,
    };
    const selectQuery = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    selectQuery.select.mockReturnValue(selectQuery);
    selectQuery.eq.mockReturnValue(selectQuery);
    selectQuery.maybeSingle.mockResolvedValue({ data: current, error: null });
    const updateQuery = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), maybeSingle: vi.fn() };
    updateQuery.update.mockReturnValue(updateQuery);
    updateQuery.eq.mockReturnValue(updateQuery);
    updateQuery.select.mockReturnValue(updateQuery);
    updateQuery.maybeSingle.mockResolvedValue({ data: { id: "run-3" }, error: null });
    const from = vi.fn().mockReturnValueOnce(selectQuery).mockReturnValueOnce(updateQuery);
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const store = new SupabaseAgentLoopStore({ from, rpc } as unknown as SupabaseClient);

    await store.markCancelled("run-3");
    const update = updateQuery.update.mock.calls[0][0];
    expect(update.state.pendingInteraction).toBeNull();
    expect(update.state.pendingResolution).toBeNull();
    expect(update.state.loopCheckpoint.pendingInteraction).toBeUndefined();
    expect(update.state.loopCheckpoint.pendingResolution).toBeUndefined();
    expect(update.resume_cursor.pendingInteraction).toBeUndefined();
    expect(update.resume_cursor.pendingResolution).toBeUndefined();
    expect(update.status).toBe("cancelled");
  });
});
