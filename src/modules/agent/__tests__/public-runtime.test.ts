import { describe, expect, it } from "vitest";

import { projectAgentLoopResultForClient } from "../application/public-runtime";
import type { AgentLoopResult } from "../application/loop";

describe("public agent runtime projection", () => {
  it("allowlists browser fields and keeps private transcript server-side", () => {
    const result: AgentLoopResult = {
      checkpoint: {
        status: "awaiting_approval",
        conversationId: "conversation-private",
        iterations: 3,
        toolCallCount: 2,
        pendingInteraction: { interactionId: "interaction-1", type: "approval", callId: "call-1", toolName: "apply_text_change", input: { text: "修改" } },
        pendingResolution: { interactionId: "interaction-1", type: "approval", callId: "call-1", toolName: "apply_text_change", input: { text: "修改" }, decision: "approved" },
        messages: [{ role: "assistant", content: "", reasoning: "PRIVATE_REASONING_SENTINEL_123", toolCalls: [{ id: "call-1", name: "apply_text_change", input: { text: "修改" } }] }, { role: "tool", content: "PRIVATE_TOOL_RESULT" }],
        permissionMode: "default",
      },
      events: [{ eventId: "event-1", runId: "run-1", timestamp: "2026-08-29T00:00:00.000Z", type: "approval.required", interactionId: "interaction-1", callId: "call-1", name: "apply_text_change", input: { text: "修改" } }],
    };
    const projected = projectAgentLoopResultForClient(result);
    const serialized = JSON.stringify(projected);
    expect(projected.checkpoint).toEqual({
      status: "awaiting_approval",
      finalText: undefined,
      iterations: 3,
      pendingInteraction: result.checkpoint.pendingInteraction,
      permissionMode: "default",
    });
    expect("messages" in projected.checkpoint).toBe(false);
    expect("conversationId" in projected.checkpoint).toBe(false);
    expect("toolCallCount" in projected.checkpoint).toBe(false);
    expect("pendingResolution" in projected.checkpoint).toBe(false);
    expect(serialized).not.toContain("PRIVATE_REASONING_SENTINEL_123");
    expect(serialized).not.toContain("PRIVATE_TOOL_RESULT");
    expect(serialized).not.toContain('"reasoning"');
  });
});
