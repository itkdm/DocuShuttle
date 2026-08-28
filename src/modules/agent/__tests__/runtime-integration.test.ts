import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentLoopRunner, TRANSPORT_INTERRUPTED, type AgentEffectReceipt, type AgentLoopCheckpoint, type AgentLoopMessage, type AgentModelPort, type AgentTool } from "../application/loop";
import type { AgentEvent } from "../application/events";
import type { AgentConversationContextPort } from "../application/ports";
import { resolveAgentRuntimeView } from "@/components/workbench/runtime-view-state";

class DurableHarness {
  checkpoint?: AgentLoopCheckpoint;
  events: AgentEvent[] = [];
  receipts = new Map<string, AgentEffectReceipt>();
  assistantMessages: string[] = [];
  userMessages: string[] = [];
  eventPersistenceFailures = 0;
  saveCount = 0;
  executionCount = 0;
  cancelled = false;

  async load() { return this.checkpoint ? structuredClone(this.checkpoint) : undefined; }
  async save(_runId: string, checkpoint: AgentLoopCheckpoint) {
    this.saveCount += 1;
    if (this.cancelled) return;
    this.checkpoint = structuredClone(checkpoint);
  }
  async saveWithAssistantMessage(runId: string, checkpoint: AgentLoopCheckpoint, message: { messageKey: string; text: string }) {
    await this.save(runId, checkpoint);
    if (!this.assistantMessages.includes(message.messageKey)) this.assistantMessages.push(message.messageKey);
  }
  async appendEvents(_runId: string, events: readonly AgentEvent[]) {
    if (this.eventPersistenceFailures) { this.eventPersistenceFailures -= 1; throw new Error("event store unavailable"); }
    this.events.push(...events);
  }
  async loadEffectReceipt(_runId: string, key: string) { return this.receipts.get(key); }
  async saveEffectReceipt(_runId: string, receipt: AgentEffectReceipt) { this.receipts.set(receipt.idempotencyKey, receipt); return receipt; }
  async appendUserMessage(_runId: string, message: { id: string; text: string }) { this.userMessages.push(message.id); }
  async markCancelled() {
    this.cancelled = true;
    if (this.checkpoint) this.checkpoint = { ...this.checkpoint, status: "cancelled", pendingInteraction: undefined, pendingResolution: undefined };
  }
  async releaseLeaseForRecovery() {}
  async heartbeat() { return true; }
  async resolvePendingApproval(_runId: string, interactionId: string, callId: string, decision: "approved" | "rejected") {
    const current = this.checkpoint;
    if (current?.pendingInteraction?.type !== "approval" || current.pendingInteraction.interactionId !== interactionId || current.pendingInteraction.callId !== callId) return undefined;
    const next = structuredClone(current);
    next.status = "running";
    next.pendingInteraction = undefined;
    next.pendingResolution = { interactionId, type: "approval", callId, toolName: current.pendingInteraction.toolName, input: current.pendingInteraction.input, decision };
    this.checkpoint = next;
    return structuredClone(next);
  }
  async resolvePendingUserInput(_runId: string, interactionId: string, message: { id: string; text: string }) {
    const current = this.checkpoint;
    if (current?.pendingInteraction?.type !== "user_input" || current.pendingInteraction.interactionId !== interactionId) return undefined;
    const next = structuredClone(current);
    next.status = "running";
    next.pendingInteraction = undefined;
    next.pendingResolution = { interactionId, type: "user_input", messageId: message.id, text: message.text };
    this.checkpoint = next;
    return structuredClone(next);
  }
}

class ContextHarness implements AgentConversationContextPort {
  calls = 0;
  constructor(private readonly messages: AgentLoopMessage[]) {}
  async loadPriorMessages() { this.calls += 1; return { conversationId: "conversation-1", messages: structuredClone(this.messages), loadedCount: this.messages.length, truncated: false, limit: 200 }; }
}

const applyTool = (harness: DurableHarness, requiresApproval = false): AgentTool => ({
  name: "apply_change",
  description: "Apply a document change.",
  inputSchema: z.object({ text: z.string() }),
  requiresApproval,
  async execute(input) { harness.executionCount += 1; return { applied: (input as { text: string }).text, revision: `rev-${harness.executionCount}` }; },
});

const runner = (model: AgentModelPort, store: DurableHarness, tools: readonly AgentTool[], context?: AgentConversationContextPort, diagnostics?: string[]) =>
  new AgentLoopRunner(model, store, tools, 24, 48, 30_000, undefined, 30_000, diagnostics ? (event) => diagnostics.push(event.event) : undefined, context);

describe("Agent runtime integration contracts", () => {
  it("completes a chat-only run with one turn start and a terminal runtime view", async () => {
    const store = new DurableHarness();
    const result = await runner({ decide: async () => ({ kind: "message", text: "文档用于记录研究结论。" }) }, store, []).run("run-chat", "介绍文档");
    expect(result.checkpoint.status).toBe("completed");
    expect(result.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(result.events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(resolveAgentRuntimeView({ run: { id: "run-chat", taskId: "task-1", status: "completed", lockVersion: 1, updatedAt: "" } }).canSend).toBe(true);
  });

  it("runs approval through the same durable run and leaves full permission automatic", async () => {
    const store = new DurableHarness();
    const tool = applyTool(store, true);
    const first = await runner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "approval-1", name: "apply_change", input: { text: "批准" } }] }) }, store, [tool]).run("run-approval", "修改文档");
    const pending = first.checkpoint.pendingInteraction;
    expect(pending?.type).toBe("approval");
    expect(store.executionCount).toBe(0);
    if (!pending || pending.type !== "approval") throw new Error("approval checkpoint missing");
    const resumed = await runner({ decide: async () => ({ kind: "message", text: "已应用。" }) }, store, [tool]).resume("run-approval", "approved", pending.interactionId, pending.callId);
    expect(resumed.checkpoint.status).toBe("completed");
    expect(store.executionCount).toBe(1);

    const fullStore = new DurableHarness();
    const fullDecisions = [{ kind: "tool_calls" as const, calls: [{ id: "full-1", name: "apply_change", input: { text: "自动" } }] }, { kind: "message" as const, text: "已自动应用。" }];
    const full = await runner({ decide: async () => fullDecisions.shift()! }, fullStore, [applyTool(fullStore)]).run("run-full", "修改文档");
    expect(full.checkpoint.status).toBe("completed");
    expect(fullStore.executionCount).toBe(1);
    expect(full.checkpoint.pendingInteraction).toBeUndefined();
  });

  it("rejects approval without executing and resumes ask_user without a second turn.started", async () => {
    const rejectedStore = new DurableHarness();
    const tool = applyTool(rejectedStore, true);
    const first = await runner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "reject-1", name: "apply_change", input: { text: "拒绝" } }] }) }, rejectedStore, [tool]).run("run-reject", "修改");
    const pending = first.checkpoint.pendingInteraction!;
    const rejected = await runner({ decide: async () => ({ kind: "message", text: "已跳过。" }) }, rejectedStore, [tool]).resume("run-reject", "rejected", pending.interactionId, pending.type === "approval" ? pending.callId : "");
    expect(rejectedStore.executionCount).toBe(0);
    expect(rejected.checkpoint.status).toBe("completed");

    const askStore = new DurableHarness();
    let calls = 0;
    const askRunner = runner({ decide: async () => calls++ === 0 ? { kind: "ask_user", text: "请提供章节。" } : { kind: "message", text: "已完成。" } }, askStore, []);
    const asked = await askRunner.run("run-ask", "开始");
    const interaction = asked.checkpoint.pendingInteraction!;
    const answered = await askRunner.runWithPermission("run-ask", "结果章节", "default", undefined, undefined, "answer-1", interaction.interactionId);
    expect(answered.checkpoint.status).toBe("completed");
    expect(answered.events.filter((event) => event.type === "turn.started")).toHaveLength(0);
    expect(askStore.userMessages).toEqual(["answer-1"]);
  });

  it("replays a receipt after recovery without executing the tool twice", async () => {
    const store = new DurableHarness();
    store.checkpoint = { status: "running", iterations: 1, toolCallCount: 1, permissionMode: "full", messages: [{ role: "assistant", content: "", toolCalls: [{ id: "crash-1", name: "apply_change", input: { text: "一次" } }] }] };
    const tool = applyTool(store);
    store.receipts.set("run-receipt:crash-1", { idempotencyKey: "run-receipt:crash-1", callId: "crash-1", toolName: "apply_change", output: { applied: "一次" }, completedAt: new Date().toISOString() });
    const recovered = await runner({ decide: async () => ({ kind: "message", text: "恢复完成。" }) }, store, [tool]).recover("run-receipt");
    expect(store.executionCount).toBe(0);
    expect(recovered.checkpoint.messages.filter((message) => message.role === "tool" && message.toolCallId === "crash-1")).toHaveLength(1);
  });

  it("keeps a document effect, receipt and recovery materialization single-shot after a lost response", async () => {
    const store = new DurableHarness();
    let executionCount = 0;
    let documentVersionCount = 0;
    const tool: AgentTool = {
      name: "apply_document",
      description: "Apply a document effect.",
      inputSchema: z.object({ text: z.string() }),
      requiresApproval: true,
      async execute(input, context) {
        executionCount += 1;
        const output = { changed: (input as { text: string }).text, revision: "revision-2" };
        if (!store.receipts.has(context.idempotencyKey)) {
          documentVersionCount += 1;
          store.receipts.set(context.idempotencyKey, { idempotencyKey: context.idempotencyKey, callId: context.callId, toolName: "apply_document", output, completedAt: "2026-08-28T00:00:00.000Z" });
        }
        return output;
      },
    };
    const first = await runner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "document-call", name: "apply_document", input: { text: "秦率博" } }] }) }, store, [tool]).run("run-document-effect", "修改姓名");
    const pending = first.checkpoint.pendingInteraction;
    if (!pending || pending.type !== "approval") throw new Error("approval checkpoint missing");
    const completed = await runner({ decide: async () => ({ kind: "message", text: "已完成修改。" }) }, store, [tool]).resume("run-document-effect", "approved", pending.interactionId, pending.callId);

    expect(executionCount).toBe(1);
    expect(documentVersionCount).toBe(1);
    expect(store.receipts.size).toBe(1);
    expect(completed.checkpoint.status).toBe("completed");
    expect(completed.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);

    const lostStore = new DurableHarness();
    const abort = new AbortController();
    let lostExecutionCount = 0;
    let lostDocumentVersionCount = 0;
    const lostTool: AgentTool = {
      ...tool,
      async execute(input, context) {
        lostExecutionCount += 1;
        const output = { changed: (input as { text: string }).text, revision: "revision-2" };
        lostDocumentVersionCount += 1;
        lostStore.receipts.set(context.idempotencyKey, { idempotencyKey: context.idempotencyKey, callId: context.callId, toolName: "apply_document", output, completedAt: "2026-08-28T00:00:00.000Z" });
        abort.abort();
        throw new Error("connection reset after commit");
      },
    };
    const lostFirst = await runner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "lost-call", name: "apply_document", input: { text: "秦率博" } }] }) }, lostStore, [lostTool]).run("run-document-lost", "修改姓名");
    const lostPending = lostFirst.checkpoint.pendingInteraction;
    if (!lostPending || lostPending.type !== "approval") throw new Error("lost approval checkpoint missing");
    await expect(runner({ decide: async () => ({ kind: "message", text: "不会到达。" }) }, lostStore, [lostTool]).resume("run-document-lost", "approved", lostPending.interactionId, lostPending.callId, abort.signal)).rejects.toThrow(TRANSPORT_INTERRUPTED);
    const recovered = await runner({ decide: async () => ({ kind: "message", text: "已从 durable effect 恢复。" }) }, lostStore, [lostTool]).recover("run-document-lost");

    expect(lostExecutionCount).toBe(1);
    expect(lostDocumentVersionCount).toBe(1);
    expect(lostStore.receipts.size).toBe(1);
    expect(recovered.checkpoint.messages.filter((message) => message.role === "tool" && message.toolCallId === "lost-call")).toHaveLength(1);
    expect(recovered.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
  });

  it("reconciles a receipt after an ambiguous normal tool error", async () => {
    const store = new DurableHarness();
    let executions = 0;
    const tool: AgentTool = {
      name: "apply_change", description: "Apply", inputSchema: z.object({ text: z.string() }),
      async execute(input, context) {
        executions += 1;
        store.receipts.set(context.idempotencyKey, { idempotencyKey: context.idempotencyKey, callId: context.callId, toolName: "apply_change", output: { applied: (input as { text: string }).text }, completedAt: new Date().toISOString() });
        throw new Error("response lost after commit");
      },
    };
    const decisions = [{ kind: "tool_calls" as const, calls: [{ id: "ambiguous-normal", name: "apply_change", input: { text: "一次" } }] }, { kind: "message" as const, text: "已完成" }];
    const result = await runner({ decide: async () => decisions.shift()! }, store, [tool]).run("run-ambiguous-normal", "修改", undefined);
    expect(result.checkpoint.status).toBe("completed");
    expect(executions).toBe(1);
    expect(store.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
    expect(store.events.some((event) => event.type === "tool.failed")).toBe(false);
  });

  it("reconciles a receipt after an ambiguous approved tool error", async () => {
    const store = new DurableHarness();
    let executions = 0;
    const tool: AgentTool = {
      name: "apply_change", description: "Apply", inputSchema: z.object({ text: z.string() }), requiresApproval: true,
      async execute(input, context) {
        executions += 1;
        store.receipts.set(context.idempotencyKey, { idempotencyKey: context.idempotencyKey, callId: context.callId, toolName: "apply_change", output: { applied: (input as { text: string }).text }, completedAt: new Date().toISOString() });
        throw new Error("response lost after commit");
      },
    };
    const paused = await runner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "ambiguous-approved", name: "apply_change", input: { text: "批准" } }] }) }, store, [tool]).run("run-ambiguous-approved", "修改");
    const pending = paused.checkpoint.pendingInteraction;
    if (!pending || pending.type !== "approval") throw new Error("approval checkpoint missing");
    const result = await runner({ decide: async () => ({ kind: "message", text: "已完成" }) }, store, [tool]).resume("run-ambiguous-approved", "approved", pending.interactionId, pending.callId);
    expect(result.checkpoint.status).toBe("completed");
    expect(result.checkpoint.pendingResolution).toBeUndefined();
    expect(executions).toBe(1);
    expect(result.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
    expect(result.events.some((event) => event.type === "tool.failed")).toBe(false);
  });

  it("reconciles a receipt after an ambiguous unfinished-tool recovery error", async () => {
    const store = new DurableHarness();
    let executions = 0;
    const tool: AgentTool = {
      name: "apply_change", description: "Apply", inputSchema: z.object({ text: z.string() }),
      async execute(input, context) {
        executions += 1;
        store.receipts.set(context.idempotencyKey, { idempotencyKey: context.idempotencyKey, callId: context.callId, toolName: "apply_change", output: { applied: (input as { text: string }).text }, completedAt: new Date().toISOString() });
        throw new Error("response lost after commit");
      },
    };
    store.checkpoint = { status: "running", iterations: 1, toolCallCount: 1, permissionMode: "full", messages: [{ role: "assistant", content: "", toolCalls: [{ id: "ambiguous-recovery", name: "apply_change", input: { text: "恢复" } }] }] };
    const result = await runner({ decide: async () => ({ kind: "message", text: "已恢复" }) }, store, [tool]).recover("run-ambiguous-recovery");
    expect(result.checkpoint.status).toBe("completed");
    expect(executions).toBe(1);
    expect(store.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
    expect(store.events.some((event) => event.type === "tool.failed")).toBe(false);
  });

  it("keeps runtime correct when EventStore fails and preserves cross-run semantic context", async () => {
    const diagnostics: string[] = [];
    const store = new DurableHarness();
    store.eventPersistenceFailures = 1;
    const context = new ContextHarness([{ role: "user", content: "用户 A" }, { role: "assistant", content: "助手 B" }]);
    let seen: AgentLoopMessage[] = [];
    const result = await runner({ decide: async ({ messages }) => { seen = [...messages]; return { kind: "message", text: "助手 C" }; } }, store, [], context, diagnostics).run("run-cross", "用户 C");
    expect(result.checkpoint.status).toBe("completed");
    expect(diagnostics).toContain("agent.event.persist_failed");
    expect(seen.filter((message) => message.role === "user" || message.role === "assistant").map((message) => message.content)).toEqual(["用户 A", "助手 B", "用户 C"]);
    expect(context.calls).toBe(1);
  });

  it("does not execute a tool after explicit cancellation", async () => {
    const store = new DurableHarness();
    const tool = applyTool(store, true);
    const first = await runner({ decide: async () => ({ kind: "tool_calls", calls: [{ id: "cancel-1", name: "apply_change", input: { text: "不要执行" } }] }) }, store, [tool]).run("run-cancel", "修改");
    expect(first.checkpoint.pendingInteraction?.type).toBe("approval");
    await store.markCancelled();
    const recovered = await runner({ decide: async () => ({ kind: "message", text: "不应到达" }) }, store, [tool]).recover("run-cancel");
    expect(store.executionCount).toBe(0);
    expect(recovered.checkpoint.status).toBe("cancelled");
    expect(store.checkpoint?.status).toBe("cancelled");
  });
});
