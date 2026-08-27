import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentLoopRunner, TRANSPORT_INTERRUPTED, type AgentEffectReceipt, type AgentLoopCheckpoint, type AgentModelPort, type AgentTool } from "../application/loop";
import type { AgentEvent } from "../application/events";

class MemoryStore {
  private value?: AgentLoopCheckpoint;
  private receipts = new Map<string, AgentEffectReceipt>();
  saves = 0;
  heartbeats = 0;
  durableEvents: AgentEvent[] = [];
  appendEventsCalls = 0;
  failEventPersistence = false;
  failFromSave?: number;
  async load() { return structuredClone(this.value); }
  async save(_runId: string, checkpoint: AgentLoopCheckpoint) { this.saves += 1; if (this.failFromSave !== undefined && this.saves >= this.failFromSave) throw new Error("simulated checkpoint failure"); this.value = structuredClone(checkpoint); }
  async heartbeat() { this.heartbeats += 1; return true; }
  async releaseLeaseForRecovery() {}
  async loadEffectReceipt(_runId: string, idempotencyKey: string) { return this.receipts.get(idempotencyKey); }
  async saveEffectReceipt(_runId: string, receipt: AgentEffectReceipt) { this.receipts.set(receipt.idempotencyKey, receipt); return receipt; }
  async appendEvents(_runId: string, events: readonly AgentEvent[]) { this.appendEventsCalls += 1; if (this.failEventPersistence) throw new Error("simulated event persistence failure"); this.durableEvents.push(...events); }
  async markCancelled() {
    if (!this.value) return;
    this.value = { ...this.value, status: "cancelled", pendingInteraction: undefined, pendingResolution: undefined };
  }
  async resolvePendingApproval(_runId: string, interactionId: string, callId: string, decision: "approved" | "rejected") {
    const checkpoint = this.value;
    if (checkpoint?.pendingInteraction?.type !== "approval" || checkpoint.pendingInteraction.interactionId !== interactionId || checkpoint.pendingInteraction.callId !== callId) return undefined;
    const claimed = structuredClone(checkpoint);
    claimed.pendingInteraction = undefined;
    claimed.status = "running";
    claimed.pendingResolution = { interactionId, type: "approval", callId, toolName: checkpoint.pendingInteraction.toolName, input: checkpoint.pendingInteraction.input, decision };
    this.value = claimed;
    return claimed;
  }
  async resolvePendingUserInput(_runId: string, interactionId: string, message: { id: string; text: string }) {
    const checkpoint = this.value;
    if (checkpoint?.pendingInteraction?.type !== "user_input" || checkpoint.pendingInteraction.interactionId !== interactionId) return undefined;
    const claimed = structuredClone(checkpoint);
    claimed.pendingInteraction = undefined;
    claimed.status = "running";
    claimed.pendingResolution = { interactionId, type: "user_input", messageId: message.id, text: message.text };
    this.value = claimed;
    return claimed;
  }
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
    expect(result.events.map((event) => event.type)).toEqual(["turn.started", "model.started", "model.completed", "tool.started", "tool.completed", "model.started", "model.completed", "assistant.message", "turn.completed"]);
    expect(result.checkpoint.messages.some((message) => message.role === "tool")).toBe(true);
    expect(result.checkpoint.messages.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.name === "inspect_document")).toBe(true);
    expect(result.events.every((event) => typeof event.eventId === "string")).toBe(true);
  });

  it("treats a transport abort as recoverable instead of cancelling the run", async () => {
    const store = new MemoryStore();
    let released = 0;
    store.releaseLeaseForRecovery = async () => { released += 1; };
    const controller = new AbortController();
    const model: AgentModelPort = { decide: async ({ signal }) => {
      await new Promise<void>((resolve) => signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("socket closed");
    } };
    const promise = new AgentLoopRunner(model, store, []).runWithPermission("run-transport", "检查", "default", controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(TRANSPORT_INTERRUPTED);
    expect(released).toBe(1);
    expect(store.durableEvents.some((event) => event.type === "turn.cancelled")).toBe(false);
    expect((await store.load())?.status).toBe("running");
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

  it("replays a durable effect receipt instead of executing the same call twice", async () => {
    const receipts = new Map<string, AgentEffectReceipt>();
    const store = new MemoryStore() as MemoryStore & {
      loadEffectReceipt: (runId: string, idempotencyKey: string) => Promise<AgentEffectReceipt | undefined>;
      saveEffectReceipt: (runId: string, receipt: AgentEffectReceipt) => Promise<AgentEffectReceipt>;
    };
    store.loadEffectReceipt = async (_runId, idempotencyKey) => receipts.get(idempotencyKey);
    store.saveEffectReceipt = async (_runId, receipt) => { receipts.set(receipt.idempotencyKey, receipt); return receipt; };
    let executions = 0;
    const tool: AgentTool = { ...inspectTool, async execute() { executions += 1; return { revision: "r1" }; } };
    let decisions = 0;
    const model: AgentModelPort = { decide: async () => {
      decisions += 1;
      if (decisions === 2) throw new Error("temporary provider failure");
      if (decisions === 4) return { kind: "message", text: "已完成。" };
      return { kind: "tool_calls", calls: [{ id: "receipt-call", name: "inspect_document", input: { query: "summary" } }] };
    } };
    const first = await new AgentLoopRunner(model, store, [tool]).run("run-receipt", "检查");
    expect(first.checkpoint.status).toBe("failed");
    expect(executions).toBe(1);
    const second = await new AgentLoopRunner(model, store, [tool]).run("run-receipt", "重试");
    expect(second.checkpoint.status).toBe("completed");
    expect(executions).toBe(1);
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
    let executions = 0;
    const applyTool: AgentTool = {
      name: "apply_change",
      description: "Apply a document change.",
      inputSchema: z.object({ nodeId: z.string() }),
      requiresApproval: true,
      async execute() { executions += 1; return { revision: "rev-2" }; },
    };
    const decisions = [
      { kind: "tool_calls" as const, calls: [{ id: "call-2", name: "apply_change", input: { nodeId: "p-1" } }] },
      { kind: "message" as const, text: "已完成。", finish: true },
    ];
    const model: AgentModelPort = { decide: async () => decisions.shift()! };
    const runner = new AgentLoopRunner(model, store, [applyTool]);
    const paused = await runner.run("run-2", "修改正文");
    expect(paused.checkpoint.status).toBe("awaiting_approval");
    expect("trace" in paused.checkpoint).toBe(false);
    expect(paused.events.some((event) => event.type === "approval.required")).toBe(true);
    const pending = paused.checkpoint.pendingInteraction;
    expect(pending?.type).toBe("approval");
    expect(executions).toBe(0);
    const streamed: string[] = [];
    const resumed = await runner.resume("run-2", "approved", pending!.interactionId, pending?.type === "approval" ? pending.callId : "", undefined, (event) => streamed.push(event.type));
    expect(resumed.checkpoint.status).toBe("completed");
    expect("trace" in resumed.checkpoint).toBe(false);
    expect(executions).toBe(1);
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
    expect(result.checkpoint.pendingInteraction).toBeUndefined();
    expect(result.events.some((event) => event.type === "tool.completed")).toBe(true);
    expect(result.events.some((event) => event.type === "approval.required")).toBe(false);
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
    const saved = await store.load();
    expect(saved && "trace" in saved).toBe(false);
    expect(store.durableEvents.some((event) => event.type === "model.started")).toBe(true);
  });

  it("heartbeats during a long provider call instead of relying on checkpoint saves", async () => {
    const store = new MemoryStore();
    const result = await new AgentLoopRunner({
      decide: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { kind: "message", text: "已完成。" };
      },
    }, store, [], 12, 32, 1_000, undefined, 5).run("run-heartbeat", "检查");
    expect(result.checkpoint.status).toBe("completed");
    expect(store.heartbeats).toBeGreaterThanOrEqual(3);
  });

  it("keeps model deltas live without persisting them", async () => {
    const store = new MemoryStore();
    const liveEvents: AgentEvent[] = [];
    const result = await new AgentLoopRunner({
      decide: async ({ onTextDelta }) => {
        for (let index = 0; index < 100; index += 1) onTextDelta?.(`片段${index}`);
        return { kind: "message", text: "已完成。" };
      },
    }, store, []).runWithPermission("run-live-deltas", "生成", "default", undefined, (event) => liveEvents.push(event));
    expect(result.checkpoint.status).toBe("completed");
    expect(liveEvents.filter((event) => event.type === "model.delta")).toHaveLength(100);
    expect(store.durableEvents.filter((event) => event.type === "model.delta")).toHaveLength(0);
    expect(store.appendEventsCalls).toBeGreaterThan(0);
  });

  it("keeps runtime correctness when event persistence fails and records a diagnostic", async () => {
    const store = new MemoryStore();
    store.failEventPersistence = true;
    const diagnostics: string[] = [];
    const result = await new AgentLoopRunner(
      { decide: async () => ({ kind: "message", text: "已完成。" }) },
      store,
      [],
      24,
      48,
      30_000,
      undefined,
      30_000,
      (event) => diagnostics.push(event.event),
    ).run("run-event-persistence-failure", "检查");
    expect(result.checkpoint.status).toBe("completed");
    expect(diagnostics).toContain("agent.event.persist_failed");
  });

  it("does not project tool.started when checkpoint save fails first", async () => {
    const store = new MemoryStore();
    store.failFromSave = 2;
    let executions = 0;
    const tool: AgentTool = { ...inspectTool, async execute() { executions += 1; return { ok: true }; } };
    const model: AgentModelPort = { decide: async () => ({ kind: "tool_calls", calls: [{ id: "checkpoint-before-event", name: "inspect_document", input: { query: "summary" } }] }) };
    await expect(new AgentLoopRunner(model, store, [tool]).run("run-checkpoint-before-event", "读取")).rejects.toThrow("simulated checkpoint failure");
    expect(store.durableEvents.some((event) => event.type === "tool.started")).toBe(false);
    expect(store.appendEventsCalls).toBe(1);
    expect(executions).toBe(0);
  });

  it("does not project turn.completed when terminal checkpoint save fails", async () => {
    const store = new MemoryStore();
    store.failFromSave = 2;
    await expect(new AgentLoopRunner({ decide: async () => ({ kind: "message", text: "完成" }) }, store, []).run("run-terminal-before-event", "执行")).rejects.toThrow("simulated checkpoint failure");
    expect(store.durableEvents.some((event) => event.type === "turn.completed")).toBe(false);
    expect(store.appendEventsCalls).toBe(1);
  });

  it("persists the tool boundary before executing a side effect", async () => {
    const store = new MemoryStore();
    let boundarySeen = false;
    const tool: AgentTool = { ...inspectTool, async execute() {
      boundarySeen = store.durableEvents.some((event) => event.type === "tool.started");
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
    expect(paused.checkpoint.status).toBe("awaiting_approval");
    expect(paused.checkpoint.pendingInteraction?.type).toBe("approval");
    expect(paused.checkpoint.pendingInteraction?.type === "approval" && paused.checkpoint.pendingInteraction.callId).toBe("apply-1");
    const assistantCalls = paused.checkpoint.messages.flatMap((message) => message.toolCalls ?? []);
    expect(assistantCalls.map((call) => call.id)).toEqual(["read-1", "apply-1"]);
    expect(assistantCalls.some((call) => call.id === "unreached-1")).toBe(false);
    const pending = paused.checkpoint.pendingInteraction;
    const resumed = await new AgentLoopRunner(model, store, [read, apply]).resume("run-approval-boundary", "approved", pending!.interactionId, pending?.type === "approval" ? pending.callId : "");
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
    const store = new MemoryStore();
    let calls = 0;
    const runner = new AgentLoopRunner({ decide: async ({ messages }) => {
      calls += 1;
      return calls === 1
        ? { kind: "ask_user", text: "你希望修改哪一个实验结论区域？" }
        : { kind: "message", text: `已按你的回答继续：${messages.at(-1)?.content}` };
    } }, store, []);
    const result = await runner.run("run-ask", "修改实验结论");
    expect(result.checkpoint.status).toBe("awaiting_user");
    expect(result.checkpoint.finalText).toBeUndefined();
    expect(result.checkpoint.pendingInteraction?.type).toBe("user_input");
    expect(result.checkpoint.pendingInteraction?.type === "user_input" && result.checkpoint.pendingInteraction.question).toContain("哪一个");
    expect(result.events.some((event) => event.type === "assistant.message")).toBe(true);
    const pending = result.checkpoint.pendingInteraction;
    const resumed = await runner.runWithPermission("run-ask", "修改实验结论第一段", "default", undefined, undefined, undefined, pending!.interactionId);
    expect(resumed.checkpoint.status).toBe("completed");
    expect(resumed.checkpoint.pendingInteraction).toBeUndefined();
    expect(resumed.checkpoint.finalText).toContain("第一段");
  });

  it("keeps user-input interaction available in full permission mode", async () => {
    const runner = new AgentLoopRunner({ decide: async () => ({ kind: "ask_user", text: "请指定要修改的章节。" }) }, new MemoryStore(), []);
    const result = await runner.runWithPermission("run-full-ask", "修改文档", "full");

    expect(result.checkpoint.status).toBe("awaiting_user");
    expect(result.checkpoint.pendingInteraction?.type).toBe("user_input");
    expect(result.events.some((event) => event.type === "approval.required")).toBe(false);
  });

  it("rejects a response for a stale interaction identity", async () => {
    const runner = new AgentLoopRunner({ decide: async () => ({ kind: "ask_user", text: "请补充目标。" }) }, new MemoryStore(), []);
    const result = await runner.run("run-stale-interaction", "开始");

    await expect(runner.runWithPermission("run-stale-interaction", "错误回答", "default", undefined, undefined, undefined, "00000000-0000-4000-8000-000000000000")).rejects.toThrow("USER_INPUT_INTERACTION_MISMATCH");
    expect(result.checkpoint.pendingInteraction?.type).toBe("user_input");
  });

  it("rejects duplicate approval and user-input consumption", async () => {
    const approvalStore = new MemoryStore();
    const approvalTool: AgentTool = { name: "apply_change", description: "Apply", inputSchema: z.object({ nodeId: z.string() }), requiresApproval: true, async execute() { return {}; } };
    const approvalRunner = new AgentLoopRunner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "duplicate-approval", name: "apply_change", input: { nodeId: "p-1" } }] }) }, approvalStore, [approvalTool]);
    const approval = await approvalRunner.run("run-duplicate-approval", "修改");
    const approvalPending = approval.checkpoint.pendingInteraction;
    await approvalRunner.resume("run-duplicate-approval", "rejected", approvalPending!.interactionId, approvalPending?.type === "approval" ? approvalPending.callId : "");
    await expect(approvalRunner.resume("run-duplicate-approval", "rejected", approvalPending!.interactionId, approvalPending?.type === "approval" ? approvalPending.callId : "")).rejects.toThrow("APPROVAL_INTERACTION_MISMATCH");

    const userStore = new MemoryStore();
    let userTurn = 0;
    const userRunner = new AgentLoopRunner({ decide: async () => userTurn++ === 0 ? { kind: "ask_user", text: "请补充信息" } : { kind: "message", text: "已完成" } }, userStore, []);
    const question = await userRunner.run("run-duplicate-user", "开始");
    const userPending = question.checkpoint.pendingInteraction;
    await userRunner.runWithPermission("run-duplicate-user", "回答", "default", undefined, undefined, undefined, userPending!.interactionId);
    await expect(userRunner.runWithPermission("run-duplicate-user", "重复回答", "default", undefined, undefined, undefined, userPending!.interactionId)).rejects.toThrow("USER_INPUT_ALREADY_CLAIMED");
  });

  it("resumes from a durable approval resolution after the original request is gone", async () => {
    const store = new MemoryStore();
    let executions = 0;
    const tool: AgentTool = { name: "apply_change", description: "Apply", inputSchema: z.object({ nodeId: z.string() }), requiresApproval: true, async execute() { executions += 1; return { ok: true }; } };
    const firstRunner = new AgentLoopRunner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "durable-approval", name: "apply_change", input: { nodeId: "p-1" } }] }) }, store, [tool]);
    const paused = await firstRunner.run("run-durable-approval", "修改");
    const pending = paused.checkpoint.pendingInteraction;
    await store.resolvePendingApproval("run-durable-approval", pending!.interactionId, pending?.type === "approval" ? pending.callId : "", "approved");

    const resumed = await new AgentLoopRunner({ decide: async () => ({ kind: "message", text: "已完成。" }) }, store, [tool]).resume(
      "run-durable-approval", "approved", pending!.interactionId, pending?.type === "approval" ? pending.callId : ""
    );
    expect(executions).toBe(1);
    expect(resumed.checkpoint.status).toBe("completed");
    expect(resumed.checkpoint.pendingResolution).toBeUndefined();
  });

  it("does not duplicate a tool result when the materialization save fails", async () => {
    const store = new MemoryStore();
    const tool: AgentTool = { name: "apply_change", description: "Apply", inputSchema: z.object({ nodeId: z.string() }), requiresApproval: true, async execute() { return { ok: true }; } };
    const paused = await new AgentLoopRunner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "crash-after-result", name: "apply_change", input: { nodeId: "p-1" } }] }) }, store, [tool]).run("run-crash-result", "修改");
    const pending = paused.checkpoint.pendingInteraction;
    await store.resolvePendingApproval("run-crash-result", pending!.interactionId, pending?.type === "approval" ? pending.callId : "", "approved");
    // Existing-resolution recovery skips the already-emitted approval event;
    // the next two saves are tool-start and result materialization.
    store.failFromSave = store.saves + 2;
    await expect(new AgentLoopRunner({ decide: async () => ({ kind: "message", text: "已完成。" }) }, store, [tool]).resume(
      "run-crash-result", "approved", pending!.interactionId, pending?.type === "approval" ? pending.callId : ""
    )).rejects.toThrow("simulated checkpoint failure");

    store.failFromSave = undefined;
    const recovered = await new AgentLoopRunner({ decide: async () => ({ kind: "message", text: "已完成。" }) }, store, [tool]).resume(
      "run-crash-result", "approved", pending!.interactionId, pending?.type === "approval" ? pending.callId : ""
    );
    expect(recovered.checkpoint.messages.filter((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.id === "crash-after-result"))).toHaveLength(1);
    expect(recovered.checkpoint.messages.filter((message) => message.role === "tool" && message.toolCallId === "crash-after-result")).toHaveLength(1);
  });

  it("does not execute a resolved approval after cancellation", async () => {
    const store = new MemoryStore();
    let executions = 0;
    const tool: AgentTool = { name: "apply_change", description: "Apply", inputSchema: z.object({ nodeId: z.string() }), requiresApproval: true, async execute() { executions += 1; return { ok: true }; } };
    const paused = await new AgentLoopRunner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "cancel-after-resolution", name: "apply_change", input: { nodeId: "p-1" } }] }) }, store, [tool]).run("run-cancel-resolution", "修改");
    const pending = paused.checkpoint.pendingInteraction;
    await store.resolvePendingApproval("run-cancel-resolution", pending!.interactionId, pending?.type === "approval" ? pending.callId : "", "approved");
    await store.markCancelled();

    const cancelled = await store.load();
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.pendingInteraction).toBeUndefined();
    expect(cancelled?.pendingResolution).toBeUndefined();
    await expect(new AgentLoopRunner({ decide: async () => ({ kind: "message", text: "不应执行" }) }, store, [tool]).resume(
      "run-cancel-resolution", "approved", pending!.interactionId, pending?.type === "approval" ? pending.callId : ""
    )).rejects.toThrow("RUN_CANCELLED");
    expect(executions).toBe(0);
  });

  it("replays a durable user-input resolution after the original request is gone", async () => {
    const store = new MemoryStore();
    const firstRunner = new AgentLoopRunner({ decide: async () => ({ kind: "ask_user", text: "请补充章节" }) }, store, []);
    const paused = await firstRunner.run("run-durable-user", "开始");
    const pending = paused.checkpoint.pendingInteraction;
    await store.resolvePendingUserInput("run-durable-user", pending!.interactionId, { id: "durable-user-message", text: "第三章" });

    const resumed = await new AgentLoopRunner({ decide: async ({ messages }) => ({ kind: "message", text: messages.some((message) => message.content === "第三章") ? "已完成。" : "回答丢失。" }) }, store, []).runWithPermission(
      "run-durable-user", "第三章", "full", undefined, undefined, "durable-user-message", pending!.interactionId
    );
    expect(resumed.checkpoint.status).toBe("completed");
    expect(resumed.checkpoint.messages.some((message) => message.role === "user" && message.content === "第三章")).toBe(true);
    expect(resumed.checkpoint.pendingResolution).toBeUndefined();
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
    const first = await runner.run("run-reject", "修改正文");
    const pending = first.checkpoint.pendingInteraction;
    const resumed = await runner.resume("run-reject", "rejected", pending!.interactionId, pending?.type === "approval" ? pending.callId : "");
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
    const before = await store.load();
    const blocked = await runner.run("run-pending", "再做另一件事");
    expect(blocked.checkpoint.status).toBe("awaiting_approval");
    expect(blocked.checkpoint.pendingInteraction?.type).toBe("approval");
    expect(blocked.checkpoint.pendingInteraction?.type === "approval" && blocked.checkpoint.pendingInteraction.callId).toBe("pending-1");
    expect(blocked.checkpoint.finalText).toBeUndefined();
    expect(blocked.checkpoint.permissionMode).toBe(before?.permissionMode);
    expect(blocked.checkpoint.messages).toEqual(before?.messages);
  });

  it.each([
    ["completed", "turn.completed"],
    ["failed", "turn.failed"],
    ["cancelled", "turn.cancelled"],
  ] as const)("replays a %s checkpoint with the matching terminal event", async (status, eventType) => {
    const store = new MemoryStore();
    await store.save("run-terminal", {
      messages: [],
      iterations: 1,
      toolCallCount: 0,
      status,
      finalText: "终态结果",
    });

    const result = await new AgentLoopRunner({ decide: async () => ({ kind: "message", text: "不应调用模型" }) }, store, []).run("run-terminal", "");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe(eventType);
  });
});
