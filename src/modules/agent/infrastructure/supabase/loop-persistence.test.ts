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
    const rpc = vi.fn().mockResolvedValue({ data: checkpoint, error: null });
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
    const rpc = vi.fn().mockResolvedValue({ data: { status: "running" }, error: null });
    const store = new SupabaseAgentLoopStore({ rpc } as unknown as SupabaseClient);

    await store.resolvePendingUserInput("run-2", "interaction-2", { id: "message-2", text: "第三章" });
    expect(rpc).toHaveBeenCalledWith("resolve_agent_loop_interaction", expect.objectContaining({
      p_interaction_type: "user_input",
      p_resolution: { interactionId: "interaction-2", type: "user_input", messageId: "message-2", text: "第三章" },
    }));
  });
});
