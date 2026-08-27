import { describe, expect, it } from "vitest";

import { buildTimeline, isTimelineActive, mergeTimelineEvents, sanitizeForDisplay } from "./agent-timeline";
import { projectAgentThread } from "./agent-thread-projection";
import { normalizeReplayEvents } from "@/modules/agent/browser-runtime";
import type { AgentEvent } from "@/modules/agent/application/events";

const toEvents = (values: readonly object[], runId = "run-test"): AgentEvent[] => values.map((value, index) => {
  const item = value as Record<string, unknown>;
  return { ...item, eventId: String(item.eventId ?? `event-${index}`), runId: String(item.runId ?? runId), timestamp: String(item.timestamp ?? `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`) } as AgentEvent;
});
const build = (values: readonly object[]) => buildTimeline(toEvents(values));

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

  it("replaces an optimistic user turn with the durable stream event by client identity", () => {
    const merged = mergeTimelineEvents(
      [{ eventId: "local:client-turn", type: "turn.started", text: "你好", clientMessageId: "message-1" }] as never,
      [{ eventId: "server-turn", type: "turn.started", text: "你好", clientMessageId: "message-1" }] as never,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ eventId: "server-turn", type: "turn.started", text: "你好" });
  });

  it("does not merge equal prompts from different turns", () => {
    const merged = mergeTimelineEvents(
      [{ eventId: "turn-1", type: "turn.started", text: "请检查", clientMessageId: "message-1" }] as never,
      [{ eventId: "turn-2", type: "turn.started", text: "请检查", clientMessageId: "message-2" }] as never,
    );
    expect(merged).toHaveLength(2);
  });

  it("projects durable message identity and run identity without flattening them", () => {
    const projection = projectAgentThread({
      messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "请检查" }], run_id: "run-1", created_at: "2026-01-01", message_key: "message-1" }],
      historicalEvents: [],
      activeEvents: toEvents([{ eventId: "event-1", type: "turn.started", text: "请检查", clientMessageId: "message-1", runId: "run-1" }]),
    });
    expect(projection.turns[0]).toMatchObject({ id: "run-1", runId: "run-1", user: { id: "message-1" } });
  });

  it("orders replayed events by sequence within a run without mixing runs", () => {
    const merged = mergeTimelineEvents([
      { eventId: "r8", type: "model.delta", text: "后", runId: "run-a", sequence: 8, timestamp: "2026-01-01T00:00:08Z" },
    ] as never, [
      { eventId: "r6", type: "turn.started", text: "前", runId: "run-a", sequence: 6, timestamp: "2026-01-01T00:00:06Z" },
      { eventId: "r7", type: "model.delta", text: "中", runId: "run-a", sequence: 7, timestamp: "2026-01-01T00:00:07Z" },
      { eventId: "other", type: "turn.started", text: "另一轮", runId: "run-b", sequence: 1, timestamp: "2026-01-01T00:00:09Z" },
    ] as never);
    expect(merged.map((event) => event.eventId)).toEqual(["r6", "r7", "r8", "other"]);
  });

  it("keeps reasoning and tool results in order while merging one tool call", () => {
    const items = build([
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
    const items = build([
      { type: "tool.started", callId: "call-2", name: "apply_text_change", input: {} },
      { type: "approval.required", callId: "call-2", name: "apply_text_change", input: {} },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", state: "approval", id: "call-2" });
  });

  it("keeps terminal status and tool duration in the timeline", () => {
    const items = build([
      { type: "tool.started", callId: "call-3", name: "inspect_document", input: {} },
      { type: "tool.completed", callId: "call-3", name: "inspect_document", output: { summary: "已读取", durationMs: 320 } },
      { type: "turn.completed", text: "已完成本轮处理" },
    ]);
    expect(items[0]).toMatchObject({ kind: "tool", state: "completed", durationMs: 320 });
    expect(items[1]).toMatchObject({ kind: "status", state: "completed", text: "本轮已完成" });
  });

  it("renders a streamed final answer as an assistant message", () => {
    const items = build([
      { type: "model.delta", text: "文档共有 3 个段落。" },
      { type: "turn.completed", text: "文档共有 3 个段落。" },
    ]);
    expect(items[0]).toMatchObject({ kind: "message", text: "文档共有 3 个段落。" });
  });

  it("keeps approval, resume, and completion on one tool card", () => {
    const items = build([
      { type: "approval.required", eventId: "approval", callId: "call-4", name: "apply_text_change", input: { nodeId: "p-1" } },
      { type: "approval.resolved", eventId: "resolved", callId: "call-4", name: "apply_text_change", decision: "approved" },
      { type: "tool.started", eventId: "resume-start", callId: "call-4", name: "apply_text_change", input: { nodeId: "p-1" } },
      { type: "tool.completed", eventId: "resume-done", callId: "call-4", name: "apply_text_change", output: { revision: "r2" } },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", id: "call-4", state: "completed" });
  });

  it("does not keep approval controls after a rejection is persisted", () => {
    const items = build([
      { type: "approval.required", callId: "call-5", name: "apply_text_change", input: {} },
      { type: "approval.resolved", callId: "call-5", name: "apply_text_change", decision: "rejected" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", state: "failed", error: "用户已拒绝此操作。" });
  });

  it("renders cancellation as a terminal timeline status", () => {
    const items = build([{ type: "turn.cancelled", text: "本轮操作已取消。" }]);
    expect(items).toEqual([{ kind: "status", id: "event-0", state: "cancelled", text: "本轮操作已取消。" }]);
  });

  it("does not mark an approval checkpoint as actively running", () => {
    const events = [
      { type: "model.delta", text: "我准备修改。" },
      { type: "approval.required", callId: "call-6", name: "apply_text_change", input: {} },
    ] as never;
    expect(isTimelineActive(events, buildTimeline(events))).toBe(false);
  });

  it("redacts secrets from expandable tool details", () => {
    expect(sanitizeForDisplay({ apiKey: "secret", nested: { password: "pw", value: "ok" } })).toEqual({ apiKey: "[已隐藏]", nested: { password: "[已隐藏]", value: "ok" } });
  });

  it("coalesces deltas and keeps activity inside one turn", () => {
    const projection = projectAgentThread({
      messages: [{ id: "u-1", role: "user", parts: [{ type: "text", text: "检查文档" }], run_id: "run-1", created_at: "2026-01-01", message_key: "u-1" }],
      historicalEvents: [],
      activeEvents: toEvents([
        { type: "turn.started", eventId: "e-1", runId: "run-1", text: "检查文档" },
        { type: "model.delta", eventId: "e-2", runId: "run-1", text: "先" },
        { type: "model.delta", eventId: "e-3", runId: "run-1", text: "检查" },
        { type: "tool.started", eventId: "e-4", runId: "run-1", callId: "call-1", name: "inspect_document", input: {} },
        { type: "tool.completed", eventId: "e-5", runId: "run-1", callId: "call-1", name: "inspect_document", output: {} },
        { type: "assistant.message", eventId: "e-6", runId: "run-1", text: "已完成" },
      ]),
    });
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].assistant.streamingContent).toBe("已完成");
    expect(projection.turns[0].assistant.activities).toMatchObject([{ type: "note", text: "先检查" }, { type: "tool", state: "completed" }]);
  });

  it("keeps equal prompts in separate turns", () => {
    const messages = ["run-1", "run-2"].map((runId, index) => ({ id: `u-${index}`, role: "user" as const, parts: [{ type: "text", text: "继续" }], run_id: runId, created_at: "2026-01-01", message_key: `u-${index}` }));
    expect(projectAgentThread({ messages, historicalEvents: [], activeEvents: [] }).turns).toHaveLength(2);
  });

  it("rejects replay events without a durable identity envelope", () => {
    expect(normalizeReplayEvents([
      { type: "model.delta", text: "ok", eventId: "e-1", runId: "run-1", sequence: 1, timestamp: "2026-01-01" },
      { type: "model.delta", text: "untrusted" },
      { type: "unknown.event", eventId: "e-3", timestamp: "2026-01-01" },
    ])).toEqual([{ type: "model.delta", text: "ok", eventId: "e-1", timestamp: "2026-01-01", runId: "run-1", sequence: 1 }]);
  });
});
