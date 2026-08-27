import { describe, expect, it } from "vitest";

import { isAgentEvent } from "../application/events";

const identity = { eventId: "event-1", runId: "run-1", timestamp: "2026-01-01T00:00:00.000Z" };

describe("isAgentEvent", () => {
  it.each([
    { type: "tool.started", callId: "call-1", name: "inspect_document" },
    { type: "tool.completed", callId: "call-1", name: "inspect_document" },
    { type: "approval.required", callId: "call-1", name: "apply_change" },
    { type: "turn.failed" },
  ])("rejects %j when its required payload is incomplete", (payload) => {
    expect(isAgentEvent({ ...identity, ...payload })).toBe(false);
  });

  it("accepts event-specific payloads, including unknown JSON values", () => {
    expect(isAgentEvent({ ...identity, type: "tool.started", callId: "call-1", name: "inspect_document", input: null })).toBe(true);
    expect(isAgentEvent({ ...identity, type: "model.delta", text: "片段", channel: "final" })).toBe(true);
    expect(isAgentEvent({ ...identity, type: "approval.resolved", callId: "call-1", name: "apply_change", decision: "rejected" })).toBe(true);
  });
});
