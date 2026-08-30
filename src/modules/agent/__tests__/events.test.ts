import { describe, expect, it } from "vitest";

import { isAgentEvent, shouldPersistAgentEvent } from "../application/events";

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
    expect(isAgentEvent({ ...identity, type: "model.commentary", text: "正在检查文档" })).toBe(true);
    expect(isAgentEvent({ ...identity, type: "approval.resolved", interactionId: "interaction-1", callId: "call-1", name: "apply_change", decision: "rejected" })).toBe(true);
    expect(isAgentEvent({ ...identity, type: "client_tool.required", interactionId: "interaction-1", callId: "call-1", name: "capture_document_view", target: "visible" })).toBe(true);
    expect(isAgentEvent({ ...identity, type: "client_tool.resolved", interactionId: "interaction-1", callId: "call-1", name: "scroll_document_view", revision: "rev-1", beforeScrollTop: 0, scrollTop: 800, maxScrollTop: 2000, viewportHeight: 1000, moved: true, atTop: false, atBottom: false })).toBe(true);
  });

  it("rejects forged or incomplete client-tool payloads", () => {
    expect(isAgentEvent({ ...identity, type: "client_tool.required", interactionId: "interaction-1", callId: "call-1", name: "scroll_document_view", kind: "relative", direction: "down", amount: "viewport", target: "bottom" })).toBe(false);
    expect(isAgentEvent({ ...identity, type: "client_tool.resolved", interactionId: "interaction-1", callId: "call-1", name: "scroll_document_view", revision: "rev-1", beforeScrollTop: -1, scrollTop: 0, maxScrollTop: 0, viewportHeight: 1000, moved: false, atTop: true, atBottom: true })).toBe(false);
    expect(isAgentEvent({ ...identity, type: "client_tool.resolved", interactionId: "interaction-1", callId: "call-1", name: "capture_document_view", assetId: "asset", mimeType: "image/png", sha256: "a".repeat(64), width: 1, height: 1, revision: "rev-1", scrollTop: 0 })).toBe(false);
  });

  it("keeps model deltas live-only while retaining structural events", () => {
    expect(shouldPersistAgentEvent({ ...identity, type: "model.delta", text: "片段" })).toBe(false);
    expect(shouldPersistAgentEvent({ ...identity, type: "model.commentary", text: "正在检查文档" })).toBe(true);
    expect(shouldPersistAgentEvent({ ...identity, type: "tool.started", callId: "call-1", name: "inspect_document", input: {} })).toBe(true);
    expect(shouldPersistAgentEvent({ ...identity, type: "turn.completed", text: "完成" })).toBe(true);
  });
});
