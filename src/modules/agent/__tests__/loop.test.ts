import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentLoopRunner, type AgentLoopCheckpoint, type AgentModelPort, type AgentTool } from "../application/loop";

class MemoryStore {
  private value?: AgentLoopCheckpoint;
  async load() { return this.value; }
  async save(_runId: string, checkpoint: AgentLoopCheckpoint) { this.value = structuredClone(checkpoint); }
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
    const resumed = await runner.resume("run-2", "approved");
    expect(resumed.checkpoint.status).toBe("completed");
    expect(resumed.checkpoint.messages.some((message) => message.toolName === "apply_change" && message.content.includes("revision"))).toBe(true);
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
});
