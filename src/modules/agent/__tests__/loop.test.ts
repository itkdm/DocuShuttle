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
    expect(result.events.map((event) => event.type)).toEqual(["tool.started", "tool.completed", "assistant.message", "completed"]);
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
    expect(paused.events[0]?.type).toBe("approval.required");
    const resumed = await runner.resume("run-2", "approved");
    expect(resumed.checkpoint.status).toBe("completed");
    expect(resumed.checkpoint.messages.some((message) => message.toolName === "apply_change" && message.content.includes("revision"))).toBe(true);
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
});
