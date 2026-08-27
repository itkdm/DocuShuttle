import { describe, expect, it } from "vitest";

import { buildTimeline, mergeTimelineEvents } from "./agent-timeline";

describe("Agent execution timeline", () => {
  it("keeps the original turn when resumed events arrive", () => {
    const first = [{ eventId: "u1", type: "turn.started", text: "改名字" }] as never;
    const resumed = [
      { eventId: "u1", type: "turn.started", text: "改名字" },
      { eventId: "t1", type: "tool.started", callId: "call-1", name: "apply_text_change" },
    ] as never;
    const merged = mergeTimelineEvents(first, resumed);
    expect(merged).toHaveLength(2);
    expect(buildTimeline(merged).map((item) => item.kind)).toEqual(["user", "tool"]);
  });

  it("keeps reasoning and tool results in order while merging one tool call", () => {
    const items = buildTimeline([
      { type: "turn.started", eventId: "u1", text: "请检查文档" },
      { type: "model.delta", eventId: "m1", text: "我先检查文档。" },
      { type: "tool.started", eventId: "t1", callId: "call-1", name: "inspect_document", input: {} },
      { type: "tool.completed", eventId: "t2", callId: "call-1", name: "inspect_document", output: { summary: "已读取" } },
      { type: "model.delta", eventId: "m2", text: "我已找到目标。" },
      { type: "assistant.message", eventId: "a1", text: "我已找到目标。" },
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user", "thought", "tool", "message"]);
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

  it("keeps terminal status and tool duration in the timeline", () => {
    const items = buildTimeline([
      { type: "tool.started", callId: "call-3", name: "inspect_document", input: {} },
      { type: "tool.completed", callId: "call-3", name: "inspect_document", output: { summary: "已读取", durationMs: 320 } },
      { type: "completed", text: "已完成本轮处理" },
    ]);
    expect(items[0]).toMatchObject({ kind: "tool", state: "completed", durationMs: 320 });
    expect(items[1]).toMatchObject({ kind: "status", state: "completed", text: "已完成本轮处理" });
  });

  it("renders a streamed final answer as an assistant message", () => {
    const items = buildTimeline([
      { type: "model.delta", text: "文档共有 3 个段落。" },
      { type: "completed", text: "文档共有 3 个段落。" },
    ]);
    expect(items[0]).toMatchObject({ kind: "message", text: "文档共有 3 个段落。" });
  });
});
