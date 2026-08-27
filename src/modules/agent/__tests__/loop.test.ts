import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentLoopRunner, type AgentLoopCheckpoint, type AgentModelPort, type AgentTool } from "../application/loop";

class MemoryStore {
  private value?: AgentLoopCheckpoint;
  saves = 0;
  async load() { return this.value; }
  async save(_runId: string, checkpoint: AgentLoopCheckpoint) { this.saves += 1; this.value = structuredClone(checkpoint); }
}

const inspectTool: AgentTool = {
  name: "inspect_document",
  description: "Inspect the current document.",
  inputSchema: z.object({ query: z.string() }),
  async execute(input: { query: string }) { return { query: input.query, regions: 3 }; },
};

describe("AgentLoopRunner", () => {
  it("lets the model choose tools and then finish naturally", async () => {
    const decisions = [
      { kind: "tool_calls" as const, calls: [{ id: "call-1", name: "inspect_document", input: { query: "headings" } }] },
      { kind: "message" as const, text: "发现 3 个区域。", finish: true },
    ];
    const model: AgentModelPort = { decide: async () => decisions.shift()! };
    const result = await new AgentLoopRunner(model, new MemoryStore(), [inspectTool]).run("run-1", "检查文档");
    expect(result.checkpoint.status).toBe("completed");
    expect(result.events.map((event) => event.type)).toEqual(["turn.started", "model.started", "model.completed", "tool.started", "tool.completed", "model.started", "model.completed", "assistant.message", "completed"]);
    expect(result.checkpoint.messages.some((message) => message.role === "tool")).toBe(true);
    expect(result.checkpoint.messages.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.name === "inspect_document")).toBe(true);
    expect(result.events.every((event) => typeof event.eventId === "string")).toBe(true);
  });

  it("does not duplicate the checkpoint save after a tool result", async () => {
    const store = new MemoryStore();
    let hasToolResult = false;
    const model: AgentModelPort = { decide: async ({ messages }) => {
      if (messages.some((message) => message.role === "tool")) return { kind: "message", text: "已完成。" };
      return { kind: "tool_calls", calls: [{ id: "save-once", name: "inspect_document", input: { query: "summary" } }] };
    } };
    const tool: AgentTool = { ...inspectTool, async execute() { hasToolResult = true; return { ok: true }; } };
    await new AgentLoopRunner(model, store, [tool]).run("run-save-once", "检查");
    expect(hasToolResult).toBe(true);
    expect(store.saves).toBe(5);
  });

  it("compacts a long model transcript without breaking tool evidence", async () => {
    const seenContexts: AgentLoopCheckpoint["messages"][] = [];
    let turn = 0;
    const model: AgentModelPort = {
      decide: async ({ messages }) => {
        seenContexts.push(structuredClone(messages) as AgentLoopCheckpoint["messages"]);
        turn += 1;
        if (turn <= 4) return { kind: "tool_calls", calls: [{ id: `inspect-${turn}`, name: "inspect_document", input: { query: `part-${turn}` } }] };
        return { kind: "message", text: "已根据文档事实完成判断。" };
      },
    };
    const result = await new AgentLoopRunner(model, new MemoryStore(), [inspectTool], 12, 12, 30_000, {
      maxCharacters: 600,
      maxMessages: 8,
      keepRecentUnits: 2,
      maxUserSummaryCharacters: 120,
    }).run("run-compaction", "请连续检查多个区域并汇总结果");
    expect(result.checkpoint.status).toBe("completed");
    expect(seenContexts.some((messages) => messages.some((message) => message.content.includes("此前对话摘要")))).toBe(true);
    for (const messages of seenContexts) {
      for (const message of messages.filter((item) => item.role === "assistant" && item.toolCalls)) {
        for (const call of message.toolCalls ?? []) {
          expect(messages.some((item) => item.role === "tool" && item.toolCallId === call.id)).toBe(true);
        }
      }
    }
  });

  it("pauses before an approval-required tool and resumes from its checkpoint", async () => {
    const store = new MemoryStore();
    const applyTool: AgentTool = {
      name: "apply_change",
      description: "Apply a document change.",
      inputSchema: z.object({ nodeId: z.string() }),
      requiresApproval: true,
      async execute() { return { revision: "rev-2" }; },
    };
    const decisions = [
      { kind: "tool_calls" as const, calls: [{ id: "call-2", name: "apply_change", input: { nodeId: "p-1" } }] },
      { kind: "message" as const, text: "已完成。", finish: true },
    ];
    const model: AgentModelPort = { decide: async () => decisions.shift()! };
    const runner = new AgentLoopRunner(model, store, [applyTool]);
    const paused = await runner.run("run-2", "修改正文");
    expect(paused.checkpoint.status).toBe("awaiting_user");
    expect(paused.events.some((event) => event.type === "approval.required")).toBe(true);
    const streamed: string[] = [];
    const resumed = await runner.resume("run-2", "approved", undefined, (event) => streamed.push(event.type));
    expect(resumed.checkpoint.status).toBe("completed");
    expect(resumed.checkpoint.messages.some((message) => message.toolName === "apply_change" && message.content.includes("revision"))).toBe(true);
    expect(streamed).toContain("assistant.message");
  });

  it("allows explicitly selected full autonomy to execute approval tools", async () => {
    const applyTool: AgentTool = {
      name: "apply_change",
      description: "Apply a document change.",
      inputSchema: z.object({ nodeId: z.string() }),
      requiresApproval: true,
      async execute() { return { revision: "rev-full" }; },
    };
    const model: AgentModelPort = { decide: async ({ messages }) => messages.some((m) => m.role === "tool")
      ? { kind: "message", text: "已自动完成。" }
      : { kind: "tool_calls", calls: [{ id: "call-full", name: "apply_change", input: { nodeId: "p-1" } }] } };
    const result = await new AgentLoopRunner(model, new MemoryStore(), [applyTool]).runWithPermission("run-full", "直接执行修改", "full");
    expect(result.checkpoint.status).toBe("completed");
    expect(result.checkpoint.pendingApproval).toBeUndefined();
    expect(result.events.some((event) => event.type === "tool.completed")).toBe(true);
  });

  it("records tool failures as tool messages so the model can recover", async () => {
    const failing: AgentTool = { ...inspectTool, async execute() { throw new Error("storage unavailable"); } };
    const model: AgentModelPort = { decide: async ({ messages }) => messages.some((m) => m.role === "tool")
      ? { kind: "message", text: "暂时无法读取文档。" }
      : { kind: "tool_calls", calls: [{ id: "call-3", name: "inspect_document", input: { query: "all" } }] } };
    const result = await new AgentLoopRunner(model, new MemoryStore(), [failing]).run("run-3", "读取文档");
    expect(result.events.some((event) => event.type === "tool.failed")).toBe(true);
    expect(result.checkpoint.status).toBe("completed");
  });

  it("persists provider failures as a failed checkpoint", async () => {
    const store = new MemoryStore();
    const result = await new AgentLoopRunner({
      decide: async () => { throw new Error("gateway timeout"); },
    }, store, []).run("run-provider-failure", "请检查文档");
    expect(result.checkpoint.status).toBe("failed");
    expect(result.checkpoint.finalText).toContain("模型服务异常");
    expect((await store.load())?.status).toBe("failed");
  });

  it("times out a provider that never resolves", async () => {
    const store = new MemoryStore();
    const result = await new AgentLoopRunner({
      decide: async ({ signal }) => await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }, store, [], 12, 32, 5).run("run-provider-timeout", "请检查文档");
    expect(result.checkpoint.status).toBe("failed");
    expect(result.checkpoint.finalText).toContain("响应超时");
    expect((await store.load())?.status).toBe("failed");
  });

  it("persists the model boundary before a provider returns", async () => {
    const store = new MemoryStore();
    const result = await new AgentLoopRunner({
      decide: async () => ({ kind: "message", text: "已完成。" }),
    }, store, []).run("run-model-boundary", "检查");
    expect(result.checkpoint.status).toBe("completed");
    expect((await store.load())?.trace?.some((event) => event.type === "model.started")).toBe(true);
  });

  it("persists the tool boundary before executing a side effect", async () => {
    const store = new MemoryStore();
    let boundarySeen = false;
    const tool: AgentTool = { ...inspectTool, async execute() {
      boundarySeen = (await store.load())?.trace?.some((event) => event.type === "tool.started") ?? false;
      return { ok: true };
    } };
    const result = await new AgentLoopRunner({
      decide: async ({ messages }) => messages.some((message) => message.role === "tool")
        ? { kind: "message", text: "已完成。" }
        : { kind: "tool_calls", calls: [{ id: "boundary-tool", name: "inspect_document", input: { query: "headings" } }] },
    }, store, [tool]).run("run-tool-boundary", "读取");
    expect(result.checkpoint.status).toBe("completed");
    expect(boundarySeen).toBe(true);
  });

  it("keeps a completed session conversational for a later user turn", async () => {
    const model: AgentModelPort = { decide: async ({ messages }) => ({
      kind: "message",
      text: messages.filter((message) => message.role === "user").length === 1 ? "第一轮完成。" : "第二轮也完成。",
    }) };
    const store = new MemoryStore();
    const runner = new AgentLoopRunner(model, store, []);
    await runner.run("run-4", "第一轮");
    const second = await runner.run("run-4", "第二轮");
    expect(second.checkpoint.status).toBe("completed");
    expect(second.checkpoint.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(second.checkpoint.finalText).toBe("第二轮也完成。");
    expect(second.checkpoint.iterations).toBe(1);
  });

  it("executes independent multi-tool reads in one model step", async () => {
    let executions = 0;
    const model: AgentModelPort = {
      decide: async ({ messages }) => messages.some((message) => message.role === "tool")
        ? { kind: "message", text: "我会按顺序继续。" }
        : { kind: "tool_calls", calls: [
            { id: "a", name: "inspect_document", input: { query: "a" } },
            { id: "b", name: "inspect_document", input: { query: "b" } },
          ] },
    };
    const tool: AgentTool = { ...inspectTool, async execute() { executions += 1; return {}; } };
    const result = await new AgentLoopRunner(model, new MemoryStore(), [tool]).run("run-5", "检查");
    expect(executions).toBe(2);
    expect(result.checkpoint.status).toBe("completed");
    expect(result.checkpoint.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("does not persist unpaired tool calls across an approval boundary", async () => {
    const store = new MemoryStore();
    const read: AgentTool = { ...inspectTool, name: "read_context" };
    const apply: AgentTool = {
      name: "apply_change",
      description: "Apply a document change.",
      inputSchema: z.object({ nodeId: z.string() }),
      requiresApproval: true,
      async execute() { return { revision: "r-2" }; },
    };
    const model: AgentModelPort = { decide: async ({ messages }) => messages.some((message) => message.role === "tool")
      ? { kind: "message", text: "已完成。" }
      : { kind: "tool_calls", calls: [
        { id: "read-1", name: "read_context", input: { query: "target" } },
        { id: "apply-1", name: "apply_change", input: { nodeId: "p-1" } },
        { id: "unreached-1", name: "read_context", input: { query: "later" } },
      ] } };
    const paused = await new AgentLoopRunner(model, store, [read, apply]).run("run-approval-boundary", "修改文档");
    expect(paused.checkpoint.status).toBe("awaiting_user");
    expect(paused.checkpoint.pendingApproval?.callId).toBe("apply-1");
    const assistantCalls = paused.checkpoint.messages.flatMap((message) => message.toolCalls ?? []);
    expect(assistantCalls.map((call) => call.id)).toEqual(["read-1", "apply-1"]);
    expect(assistantCalls.some((call) => call.id === "unreached-1")).toBe(false);
    const resumed = await new AgentLoopRunner(model, store, [read, apply]).resume("run-approval-boundary", "approved");
    expect(resumed.checkpoint.status).toBe("completed");
  });

  it("allows the model to revisit a tool and change route after its result", async () => {
    const calls: string[] = [];
    let step = 0;
    const model: AgentModelPort = { decide: async () => {
      step += 1;
      if (step === 1) return { kind: "tool_calls", calls: [{ id: "a1", name: "inspect_document", input: { query: "first" } }] };
      if (step === 2) return { kind: "tool_calls", calls: [{ id: "b1", name: "inspect_document", input: { query: "second" } }] };
      return { kind: "message", text: "结果需要进一步确认。" };
    } };
    const tool: AgentTool = { ...inspectTool, async execute(input) { const query = (input as { query: string }).query; calls.push(query); return { regions: query === "first" ? 0 : 2 }; } };
    const result = await new AgentLoopRunner(model, new MemoryStore(), [tool]).run("run-revisit", "先查找，不确定时再查一次");
    expect(calls).toEqual(["first", "second"]);
    expect(result.checkpoint.status).toBe("completed");
  });

  it("lets the model ask the user when evidence is insufficient", async () => {
    const result = await new AgentLoopRunner({ decide: async () => ({ kind: "ask_user", text: "你希望修改哪一个实验结论区域？" }) }, new MemoryStore(), []).run("run-ask", "修改实验结论");
    expect(result.checkpoint.status).toBe("awaiting_user");
    expect(result.checkpoint.finalText).toBeUndefined();
    expect(result.events.some((event) => event.type === "assistant.message")).toBe(true);
  });

  it("exposes a terminal safety-budget failure in the timeline", async () => {
    const model: AgentModelPort = { decide: async () => ({ kind: "tool_calls", calls: [{ id: crypto.randomUUID(), name: "inspect_document", input: { query: "again" } }] }) };
    const result = await new AgentLoopRunner(model, new MemoryStore(), [inspectTool], 12, 1).run("run-budget", "持续检查");
    expect(result.checkpoint.status).toBe("failed");
    expect(result.events.at(-2)).toMatchObject({ type: "assistant.message" });
    expect(result.events.at(-1)).toMatchObject({ type: "turn.failed" });
  });

  it("feeds a rejected approval back to the model for a different response", async () => {
    const store = new MemoryStore();
    const applyTool: AgentTool = { name: "apply_change", description: "Apply", inputSchema: z.object({ nodeId: z.string() }), requiresApproval: true, async execute() { return { revision: "r" }; } };
    let calls = 0;
    const model: AgentModelPort = { decide: async ({ messages }) => {
      calls += 1;
      return messages.some((message) => message.role === "tool") ? { kind: "message", text: "好的，我不会修改文档。" } : { kind: "tool_calls", calls: [{ id: "reject-1", name: "apply_change", input: { nodeId: "p-1" } }] };
    } };
    const runner = new AgentLoopRunner(model, store, [applyTool]);
    await runner.run("run-reject", "修改正文");
    const resumed = await runner.resume("run-reject", "rejected");
    expect(calls).toBe(2);
    expect(resumed.checkpoint.status).toBe("completed");
    expect(resumed.checkpoint.finalText).toContain("不会修改");
    expect(resumed.events.map((event) => event.type)).not.toContain("tool.started");
  });

  it("does not start a second user turn while approval is pending", async () => {
    const store = new MemoryStore();
    const applyTool: AgentTool = { name: "apply_change", description: "Apply", inputSchema: z.object({ nodeId: z.string() }), requiresApproval: true, async execute() { return {}; } };
    const model: AgentModelPort = { decide: async () => ({ kind: "tool_calls", calls: [{ id: "pending-1", name: "apply_change", input: { nodeId: "p-1" } }] }) };
    const runner = new AgentLoopRunner(model, store, [applyTool]);
    await runner.run("run-pending", "修改文档");
    const blocked = await runner.run("run-pending", "再做另一件事");
    expect(blocked.checkpoint.status).toBe("awaiting_user");
    expect(blocked.checkpoint.pendingApproval?.callId).toBe("pending-1");
    expect(blocked.checkpoint.finalText).toContain("等待确认");
  });
});
