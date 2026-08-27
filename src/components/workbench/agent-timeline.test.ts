import { describe, expect, it } from "vitest";

import { buildTimeline } from "./agent-timeline";

describe("Agent execution timeline", () => {
  it("keeps reasoning and tool results in order while merging one tool call", () => {
    const items = buildTimeline([
      { type: "turn.started", eventId: "u1", text: "请检查文档" },
      { type: "model.delta", eventId: "m1", text: "我先检查文档。" },
      { type: "tool.started", eventId: "t1", callId: "call-1", name: "inspect_document", input: {} },
      { type: "tool.completed", eventId: "t2", callId: "call-1", name: "inspect_document", output: { summary: "已读取" } },
      { type: "model.delta", eventId: "m2", text: "我已找到目标。" },
      { type: "assistant.message", eventId: "a1", text: "我已找到目标。" },
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user", "thought", "tool", "thought"]);
    expect(items[2]).toMatchObject({ kind: "tool", id: "call-1", state: "completed" });
  });

  it("attaches approval to the original tool card", () => {
    const items = buildTimeline([
      { type: "tool.started", callId: "call-2", name: "apply_text_change", input: {} },
      { type: "approval.required", callId: "call-2", name: "apply_text_change", input: {} },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", state: "approval", id: "call-2" });
  });
});
