import { describe, expect, it } from "vitest";

import type { AgentEvent } from "@/modules/agent/application/events";
import { reduceAgentEvents } from "./agent-turn-reducer";

const event = (payload: AgentEvent): AgentEvent => payload;

describe("agent turn tool validation presentation", () => {
  it("keeps structured validation details while showing a concise failure summary", () => {
    const validation = { error: "TOOL_INPUT_VALIDATION_FAILED", issues: [{ path: "limit", code: "too_big", message: "Too big: expected number to be <=80", maximum: 80 }] };
    const state = reduceAgentEvents([event({ eventId: "failed-1", runId: "run-1", timestamp: "2026-01-01T00:00:00.000Z", type: "tool.failed", callId: "call-1", name: "list_document_regions", error: JSON.stringify(validation) })], "run-1");
    expect(state.activities[0]).toMatchObject({ type: "tool", state: "failed", error: "参数不符合要求", errorDetails: validation });
  });
});

describe("agent turn durable commentary", () => {
  const base = { runId: "run-1", timestamp: "2026-01-01T00:00:00.000Z" };

  it("replays a durable commentary note without a live delta", () => {
    const state = reduceAgentEvents([{ ...base, eventId: "commentary-1", type: "model.commentary", text: "正在检查文档" }], "run-1");
    expect(state.activities).toEqual([{ type: "note", id: "commentary-1", text: "正在检查文档" }]);
    expect(state.activeNoteId).toBeUndefined();
  });

  it("reconciles a durable snapshot with an identical or partial live note", () => {
    const identical = reduceAgentEvents([
      { ...base, eventId: "delta-1", type: "model.delta", text: "正在检查文档" },
      { ...base, eventId: "commentary-1", type: "model.commentary", text: "正在检查文档" },
    ], "run-1");
    expect(identical.activities).toEqual([{ type: "note", id: "delta-1", text: "正在检查文档" }]);

    const completed = reduceAgentEvents([
      { ...base, eventId: "delta-2", type: "model.delta", text: "正在检查" },
      { ...base, eventId: "commentary-2", type: "model.commentary", text: "正在检查文档" },
    ], "run-1");
    expect(completed.activities).toEqual([{ type: "note", id: "delta-2", text: "正在检查文档" }]);
  });

  it("keeps distinct ask_user commentary in execution history while showing the question as the answer", () => {
    const state = reduceAgentEvents([
      { ...base, eventId: "commentary-ask", type: "model.commentary", text: "我还需要确认一个信息。" },
      { ...base, eventId: "message-ask", type: "assistant.message", text: "请选择目标表格。" },
    ], "run-1");
    expect(state.activities).toEqual([{ type: "note", id: "commentary-ask", text: "我还需要确认一个信息。" }]);
    expect(state.streamingContent).toBe("请选择目标表格。");
  });
});

describe("agent turn client tool replay", () => {
  it("keeps the captured asset metadata for historical screenshot rendering", () => {
    const state = reduceAgentEvents([{
      runId: "run-1", eventId: "client-resolved", timestamp: "2026-01-01T00:00:00.000Z",
      type: "client_tool.resolved", interactionId: "interaction-1", callId: "call-1", name: "capture_document_view",
      assetId: "preview-1", mimeType: "image/png", sha256: "a".repeat(64), width: 794, height: 6490, revision: "rev-1",
    }], "run-1");
    expect(state.activities[0]).toMatchObject({ type: "tool", name: "capture_document_view", state: "completed", output: { assetId: "preview-1", revision: "rev-1" } });
  });
});
