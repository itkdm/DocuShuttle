import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { SupabaseAgentRunStore } from "./runtime-persistence";

describe("SupabaseAgentRunStore fresh-run path", () => {
  it("uses one atomic task RPC instead of serial document and revision reads", async () => {
    const from = vi.fn();
    const rpc = vi.fn().mockResolvedValue({
      data: {
        run: {
          id: "run-new",
          taskId: "task-1",
          documentId: "document-1",
          baseRevision: "a".repeat(64),
          conversationId: "conversation-1",
          status: "queued",
          lockVersion: 0,
          updatedAt: "2026-08-28T00:00:00.000Z",
        },
        timings: { activeRunCheckMs: 1, workingDocumentMs: 2, revisionMs: 1, createTurnRpcMs: 4 },
      },
      error: null,
    });
    const store = new SupabaseAgentRunStore({ from, rpc } as unknown as SupabaseClient);

    const run = await store.createForTask({ taskId: "task-1", ownerUserId: "user-1", now: "2026-08-28T00:00:00.000Z", goal: "回答" });

    expect(run.documentId).toBe("document-1");
    expect(run.conversationId).toBe("conversation-1");
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("create_agent_turn_from_task", expect.objectContaining({
      p_task_id: "task-1",
      p_goal: "回答",
    }));
  });
});
