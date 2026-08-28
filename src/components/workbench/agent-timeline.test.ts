import { describe, expect, it } from "vitest";

import { buildTimeline, isTimelineActive, mergeTimelineEvents, sanitizeForDisplay } from "./agent-timeline";
import { executionSummary, projectAgentThread } from "./agent-thread-projection";
import { normalizeReplayEvents } from "@/modules/agent/browser-runtime";
import type { AgentEvent } from "@/modules/agent/application/events";

const toEvents = (values: readonly object[], runId = "run-test"): AgentEvent[] => values.map((value, index) => {
  const item = value as Record<string, unknown>;
  return { ...item, eventId: String(item.eventId ?? `event-${index}`), runId: String(item.runId ?? runId), timestamp: String(item.timestamp ?? `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`) } as AgentEvent;
});
const build = (values: readonly object[]) => buildTimeline(toEvents(values));

describe("Agent execution timeline", () => {
  it("keeps the assistant running after a tool completes without a terminal event", () => {
    const projection = projectAgentThread({
      messages: [{ id: "u-running", role: "user", parts: [{ type: "text", text: "检查" }], run_id: "run-running", created_at: "2026-01-01", message_key: "u-running" }],
      historicalEvents: [],
      activeEvents: toEvents([
        { type: "tool.started", callId: "call-running", name: "inspect_document", input: {} },
        { type: "tool.completed", callId: "call-running", name: "inspect_document", output: {} },
      ], "run-running"),
    });
    expect(projection.turns[0].assistant.status).toBe("running");
  });

  it("keeps execution running across later model and tool activity", () => {
    const projection = projectAgentThread({
      messages: [{ id: "u-multi", role: "user", parts: [{ type: "text", text: "检查" }], run_id: "run-multi", created_at: "2026-01-01", message_key: "u-multi" }],
      historicalEvents: [],
      activeEvents: toEvents([
        { type: "tool.completed", callId: "call-one", name: "inspect_document", output: {} },
        { type: "model.started" },
        { type: "model.delta", text: "继续处理" },
        { type: "tool.started", callId: "call-two", name: "read_document_region", input: {} },
      ], "run-multi"),
    });
    expect(projection.turns[0].assistant.status).toBe("running");
  });

  it("keeps a failed tool non-terminal while the runtime continues", () => {
    const projection = projectAgentThread({
      messages: [{ id: "u-tool-failed", role: "user", parts: [{ type: "text", text: "检查" }], run_id: "run-tool-failed", created_at: "2026-01-01", message_key: "u-tool-failed" }],
      historicalEvents: [],
      activeEvents: toEvents([
        { type: "tool.failed", callId: "call-failed", name: "inspect_document", error: "暂时失败" },
        { type: "model.started" },
      ], "run-tool-failed"),
    });
    expect(projection.turns[0].assistant.status).toBe("running");
    expect(projection.turns[0].assistant.activities).toMatchObject([{ type: "tool", state: "failed" }]);
  });

  it("summarizes only completed tool activities", () => {
    const activities = [
      { type: "tool", id: "done", callId: "done", name: "inspect_document", state: "completed" },
      { type: "tool", id: "running", callId: "running", name: "inspect_document", state: "running" },
      { type: "tool", id: "approval", callId: "approval", name: "apply_text_change", state: "approval" },
      { type: "tool", id: "failed", callId: "failed", name: "inspect_document", state: "failed" },
    ] as const;
    expect(executionSummary("running", activities)).toBe("正在处理");
    expect(executionSummary("awaiting_approval", activities)).toBe("等待确认");
    expect(executionSummary("completed", activities)).toBe("已完成 1 个步骤");
    expect(executionSummary("failed", activities)).toBe("执行未完成");
  });

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

  it("replaces a live event with its durable replay version", () => {
    const merged = mergeTimelineEvents(
      [{ eventId: "same", type: "tool.started", callId: "call-1", name: "inspect_document" }] as never,
      [{ eventId: "same", type: "tool.started", callId: "call-1", name: "inspect_document", sequence: 10 }] as never,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ eventId: "same", sequence: 10 });
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
    expect(projection.turns[0]).toMatchObject({ id: "message-1", runId: "run-1", user: { id: "message-1" } });
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
      { type: "approval.required", interactionId: "interaction-2", callId: "call-2", name: "apply_text_change", input: {} },
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
      { type: "approval.required", interactionId: "interaction-4", eventId: "approval", callId: "call-4", name: "apply_text_change", input: { nodeId: "p-1" } },
      { type: "approval.resolved", interactionId: "interaction-4", eventId: "resolved", callId: "call-4", name: "apply_text_change", decision: "approved" },
      { type: "tool.started", eventId: "resume-start", callId: "call-4", name: "apply_text_change", input: { nodeId: "p-1" } },
      { type: "tool.completed", eventId: "resume-done", callId: "call-4", name: "apply_text_change", output: { revision: "r2" } },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", id: "call-4", state: "completed" });
  });

  it("does not keep approval controls after a rejection is persisted", () => {
    const items = build([
      { type: "approval.required", interactionId: "interaction-5", callId: "call-5", name: "apply_text_change", input: {} },
      { type: "approval.resolved", interactionId: "interaction-5", callId: "call-5", name: "apply_text_change", decision: "rejected" },
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
      { type: "approval.required", interactionId: "interaction-6", callId: "call-6", name: "apply_text_change", input: {} },
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
      ], "run-chronology"),
    });
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].assistant.streamingContent).toBe("已完成");
    expect(projection.turns[0].assistant.activities).toMatchObject([{ type: "note", text: "先检查" }, { type: "tool", state: "completed" }]);
  });

  it("keeps interleaved commentary in chronological execution notes and deduplicates approval", () => {
    const projection = projectAgentThread({
      messages: [
        { id: "u-chronology", role: "user", parts: [{ type: "text", text: "修改文档" }], run_id: "run-chronology", created_at: "2026-01-01", message_key: "u-chronology" },
        { id: "a-chronology", role: "assistant", parts: [{ type: "text", text: "C-final" }], run_id: "run-chronology", created_at: "2026-01-01T00:00:10Z", message_key: "a-chronology" },
      ],
      historicalEvents: [],
      activeEvents: toEvents([
        { type: "model.delta", text: "A" },
        { type: "approval.required", interactionId: "i-1", callId: "call-1", name: "apply_text_change", input: {} },
        { type: "approval.resolved", interactionId: "i-1", callId: "call-1", name: "apply_text_change", decision: "approved" },
        { type: "tool.started", callId: "call-1", name: "apply_text_change", input: {} },
        { type: "tool.completed", callId: "call-1", name: "apply_text_change", output: {} },
        { type: "model.delta", text: "B" },
        { type: "tool.started", callId: "call-2", name: "inspect_document", input: {} },
        { type: "tool.completed", callId: "call-2", name: "inspect_document", output: {} },
        { type: "model.delta", text: "C" },
        { type: "assistant.message", text: "C-final" },
      ], "run-chronology"),
    });
    const assistant = projection.turns[0].assistant;
    expect(assistant.activities.map((activity) => activity.type === "note" ? activity.text : activity.callId)).toEqual(["A", "call-1", "B", "call-2"]);
    expect(assistant.activities.filter((activity) => activity.type === "tool" && activity.callId === "call-1")).toHaveLength(1);
    expect(assistant.finalContent).toBe("C-final");
    expect(assistant.streamingContent).toBeUndefined();
  });

  it("keeps equal prompts in separate turns", () => {
    const messages = ["run-1", "run-2"].map((runId, index) => ({ id: `u-${index}`, role: "user" as const, parts: [{ type: "text", text: "继续" }], run_id: runId, created_at: "2026-01-01", message_key: `u-${index}` }));
    expect(projectAgentThread({ messages, historicalEvents: [], activeEvents: [] }).turns).toHaveLength(2);
  });

  it("does not guess an unbound message into the active run", () => {
    const projection = projectAgentThread({
      messages: [{ id: "optimistic", role: "user", parts: [{ type: "text", text: "新消息" }], created_at: "2026-01-01T00:00:02Z", message_key: "optimistic", delivery_status: "pending" }],
      historicalEvents: [], activeEvents: toEvents([{ type: "turn.started", text: "旧消息", runId: "old-run", timestamp: "2026-01-01T00:00:01Z" }]), activeRunId: "old-run",
    });
    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[0].id).toBe("old-run:user");
    expect(projection.turns[1]).toMatchObject({ id: "optimistic", user: { id: "optimistic", deliveryStatus: "pending" }, assistant: { status: "running" } });
    expect(projection.turns[1].runId).toBeUndefined();
  });

  it("keeps multiple semantic messages in chronological order within one run", () => {
    const messages = [
      { id: "u-a", role: "user" as const, parts: [{ type: "text", text: "A" }], run_id: "run-1", created_at: "2026-01-01T00:00:01Z", message_key: "u-a" },
      { id: "a-b", role: "assistant" as const, parts: [{ type: "text", text: "B" }], run_id: "run-1", created_at: "2026-01-01T00:00:02Z", message_key: "a-b" },
      { id: "u-c", role: "user" as const, parts: [{ type: "text", text: "C" }], run_id: "run-1", created_at: "2026-01-01T00:00:03Z", message_key: "u-c" },
      { id: "a-d", role: "assistant" as const, parts: [{ type: "text", text: "D" }], run_id: "run-1", created_at: "2026-01-01T00:00:04Z", message_key: "a-d" },
    ];
    const turns = projectAgentThread({ messages, historicalEvents: [], activeEvents: [] }).turns;
    expect(turns.map((turn) => turn.id)).toEqual(["u-a", "u-c"]);
    expect(turns.map((turn) => [turn.user?.content, turn.assistant.finalContent])).toEqual([["A", "B"], ["C", "D"]]);
  });

  it("attributes same-run streaming events to the latest semantic user phase", () => {
    const messages = [
      { id: "u-a", role: "user" as const, parts: [{ type: "text", text: "A" }], run_id: "run-1", created_at: "2026-01-01T00:00:01Z", message_key: "u-a" },
      { id: "a-b", role: "assistant" as const, parts: [{ type: "text", text: "你希望改成什么？" }], run_id: "run-1", created_at: "2026-01-01T00:00:02Z", message_key: "a-b" },
      { id: "u-c", role: "user" as const, parts: [{ type: "text", text: "改成专业一点" }], run_id: "run-1", created_at: "2026-01-01T00:00:05Z", message_key: "u-c" },
    ];
    const events = toEvents([
      { eventId: "old-start", type: "model.started", runId: "run-1", timestamp: "2026-01-01T00:00:01Z" },
      { eventId: "old-answer", type: "assistant.message", text: "你希望改成什么？", runId: "run-1", timestamp: "2026-01-01T00:00:02Z" },
      { eventId: "new-start", type: "model.started", runId: "run-1", timestamp: "2026-01-01T00:00:06Z" },
      { eventId: "new-delta-1", type: "model.delta", text: "正在", runId: "run-1", timestamp: "2026-01-01T00:00:07Z" },
      { eventId: "new-delta-2", type: "model.delta", text: "修改", runId: "run-1", timestamp: "2026-01-01T00:00:08Z" },
    ]);
    const projection = projectAgentThread({ messages: [...messages].reverse(), historicalEvents: events.slice(0, 2).reverse(), activeEvents: events.slice(2).reverse() });
    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[0].assistant.finalContent).toBe("你希望改成什么？");
    expect(projection.turns[0].assistant.streamingContent).toBeUndefined();
    expect(projection.turns[1]).toMatchObject({ user: { content: "改成专业一点" }, assistant: { streamingContent: "正在修改" } });
    const withTool = projectAgentThread({ messages, historicalEvents: [], activeEvents: [...events, ...toEvents([
      { eventId: "tool-start", type: "tool.started", callId: "call-1", name: "apply_text_change", input: {}, runId: "run-1", timestamp: "2026-01-01T00:00:08Z" },
      { eventId: "tool-done", type: "tool.completed", callId: "call-1", name: "apply_text_change", output: {}, runId: "run-1", timestamp: "2026-01-01T00:00:09Z" },
    ])] });
    expect(withTool.turns[1].assistant.activities.find((activity) => activity.type === "tool")).toMatchObject({ callId: "call-1", state: "completed" });
  });

  it("replaces the pending assistant phase when final D arrives", () => {
    const base = [
      { id: "u-c", role: "user" as const, parts: [{ type: "text", text: "C" }], run_id: "run-1", created_at: "2026-01-01T00:00:05Z", message_key: "u-c" },
    ];
    const final = { id: "a-d", role: "assistant" as const, parts: [{ type: "text", text: "已经修改完成" }], run_id: "run-1", created_at: "2026-01-01T00:00:09Z", message_key: "a-d" };
    const events = toEvents([{ eventId: "delta", type: "model.delta", text: "正在修改", runId: "run-1", timestamp: "2026-01-01T00:00:07Z" }]);
    const projection = projectAgentThread({ messages: [...base, final].reverse(), historicalEvents: [], activeEvents: events });
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0].id).toBe("u-c");
    expect(projection.turns[0].assistant.finalContent).toBe("已经修改完成");
    expect(projection.turns[0].assistant.streamingContent).toBeUndefined();
  });

  it("does not leave approval pending after resolution and terminal completion", () => {
    const events = toEvents([
      { eventId: "required", type: "approval.required", interactionId: "i-1", callId: "c-1", name: "apply_text_change", input: {} },
      { eventId: "resolved", type: "approval.resolved", interactionId: "i-1", callId: "c-1", name: "apply_text_change", decision: "approved" },
      { eventId: "done", type: "tool.completed", callId: "c-1", name: "apply_text_change", output: {} },
      { eventId: "message", type: "assistant.message", text: "完成" },
      { eventId: "complete", type: "turn.completed", text: "完成" },
    ]);
    const projection = projectAgentThread({ messages: [{ id: "u-1", role: "user", parts: [{ type: "text", text: "修改" }], run_id: "run-1", created_at: "2026-01-01", message_key: "u-1" }], historicalEvents: [], activeEvents: events });
    expect(projection.turns[0].assistant.status).toBe("completed");
  });

  it("keeps a rejected approval non-terminal while the run can continue", () => {
    const events = toEvents([
      { eventId: "required", type: "approval.required", interactionId: "i-2", callId: "c-2", name: "apply_text_change", input: {} },
      { eventId: "resolved", type: "approval.resolved", interactionId: "i-2", callId: "c-2", name: "apply_text_change", decision: "rejected" },
    ]);
    const projection = projectAgentThread({ messages: [{ id: "u-2", role: "user", parts: [{ type: "text", text: "修改" }], run_id: "run-2", created_at: "2026-01-01", message_key: "u-2" }], historicalEvents: [], activeEvents: events });
    expect(projection.turns[0].assistant.status).toBe("running");
    expect(projection.turns[0].assistant.activities).toMatchObject([{ type: "tool", state: "failed", error: "已拒绝" }]);
  });

  it("projects a rejected approval followed by an assistant response as completed", () => {
    const projection = projectAgentThread({
      messages: [{ id: "u-3", role: "user", parts: [{ type: "text", text: "修改" }], run_id: "run-3", created_at: "2026-01-01", message_key: "u-3" }],
      historicalEvents: [],
      activeEvents: toEvents([
        { eventId: "required", type: "approval.required", interactionId: "i-3", callId: "c-3", name: "apply_text_change", input: {} },
        { eventId: "resolved", type: "approval.resolved", interactionId: "i-3", callId: "c-3", name: "apply_text_change", decision: "rejected" },
        { eventId: "message", type: "assistant.message", text: "好的，我没有修改文档。" },
        { eventId: "complete", type: "turn.completed", text: "好的，我没有修改文档。" },
      ]),
    });
    expect(projection.turns[0].assistant.status).toBe("completed");
    expect(projection.turns[0].assistant.activities).toMatchObject([{ type: "tool", state: "failed", error: "已拒绝" }]);
  });

  it("lets terminal failure and cancellation override a resolved approval", () => {
    for (const [runId, terminal] of [["failed-run", "turn.failed"], ["cancelled-run", "turn.cancelled"]] as const) {
      const events = toEvents([
        { eventId: "required", type: "approval.required", interactionId: runId, callId: runId, name: "apply_text_change", input: {} },
        { eventId: "resolved", type: "approval.resolved", interactionId: runId, callId: runId, name: "apply_text_change", decision: "rejected" },
        { eventId: "terminal", type: terminal, text: "结束" },
      ], runId);
      const projection = projectAgentThread({
        messages: [{ id: runId, role: "user", parts: [{ type: "text", text: "修改" }], run_id: runId, created_at: "2026-01-01", message_key: runId }],
        historicalEvents: [],
        activeEvents: events,
      });
      expect(projection.turns[0].assistant.status).toBe(terminal === "turn.failed" ? "failed" : "cancelled");
    }
  });

  it("rejects replay events without a durable identity envelope", () => {
    expect(normalizeReplayEvents([
      { type: "model.delta", text: "ok", eventId: "e-1", runId: "run-1", sequence: 1, timestamp: "2026-01-01" },
      { type: "model.delta", text: "untrusted" },
      { type: "unknown.event", eventId: "e-3", timestamp: "2026-01-01" },
    ])).toEqual([{ type: "model.delta", text: "ok", eventId: "e-1", timestamp: "2026-01-01", runId: "run-1", sequence: 1 }]);
  });
});
