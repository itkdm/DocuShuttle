import { z } from "zod";

export type AgentLoopMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ReadonlyArray<{ id: string; name: string; input: unknown }>;
};

export type AgentToolContext = {
  runId: string;
  callId: string;
  idempotencyKey: string;
  attempt: number;
  signal?: AbortSignal;
};

export type AgentTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: TSchema;
  requiresApproval?: boolean;
  execute(input: z.infer<TSchema>, context: AgentToolContext): Promise<unknown>;
};

export type AgentModelDecision =
  | { kind: "message"; text: string; finish?: boolean }
  | { kind: "tool_calls"; calls: ReadonlyArray<{ id: string; name: string; input: unknown }> }
  | { kind: "ask_user"; text: string };

/** Controls how much autonomy the user grants to this run. */
export type AgentPermissionMode = "default" | "full";

export interface AgentModelPort {
  decide(input: {
    messages: readonly AgentLoopMessage[];
    tools: readonly AgentTool[];
    signal?: AbortSignal;
  }): Promise<AgentModelDecision>;
}

export type AgentLoopCheckpoint = {
  messages: AgentLoopMessage[];
  iterations: number;
  toolCallCount: number;
  pendingApproval?: { callId: string; name: string; input: unknown };
  status: "running" | "awaiting_user" | "completed" | "failed";
  finalText?: string;
  permissionMode?: AgentPermissionMode;
};

export type AgentLoopStore = {
  load(runId: string): Promise<AgentLoopCheckpoint | undefined>;
  save(runId: string, checkpoint: AgentLoopCheckpoint): Promise<void>;
  claimPendingApproval?(runId: string, callId: string): Promise<AgentLoopCheckpoint | undefined>;
};

export type AgentLoopEvent =
  | { type: "assistant.message"; text: string }
  | { type: "tool.started"; callId: string; name: string; input: unknown }
  | { type: "tool.completed"; callId: string; name: string; output: unknown }
  | { type: "tool.failed"; callId: string; name: string; error: string }
  | { type: "approval.required"; callId: string; name: string; input: unknown }
  | { type: "completed"; text: string };

export type AgentLoopResult = {
  checkpoint: AgentLoopCheckpoint;
  events: AgentLoopEvent[];
};

const serializeToolOutput = (value: unknown) => {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
};

export class AgentLoopRunner {
  constructor(
    private readonly model: AgentModelPort,
    private readonly store: AgentLoopStore,
    private readonly tools: readonly AgentTool[],
    private readonly maxIterations = 12,
    private readonly maxToolCalls = 32,
    private readonly modelTimeoutMs = 30_000,
  ) {}

  async run(runId: string, userText: string, signal?: AbortSignal): Promise<AgentLoopResult> {
    return this.runWithPermission(runId, userText, "default", signal);
  }

  async runWithPermission(runId: string, userText: string, permissionMode: AgentPermissionMode, signal?: AbortSignal): Promise<AgentLoopResult> {
    const current = await this.store.load(runId);
    const checkpoint: AgentLoopCheckpoint = current ?? {
      messages: [],
      iterations: 0,
      toolCallCount: 0,
      status: "running",
      permissionMode,
    };
    // Permission is selected per user turn. A resumed approval keeps the mode
    // persisted in its checkpoint, while a new turn may intentionally switch
    // between the default guardrail profile and full autonomy.
    if (userText.trim()) checkpoint.permissionMode = permissionMode;
    else checkpoint.permissionMode ??= permissionMode;
    if ((checkpoint.status === "completed" || checkpoint.status === "failed") && !userText.trim()) {
      return { checkpoint, events: checkpoint.finalText ? [{ type: "completed", text: checkpoint.finalText }] : [] };
    }
    if (userText.trim()) checkpoint.messages.push({ role: "user", content: userText });
    checkpoint.status = "running";
    checkpoint.finalText = undefined;
    const events: AgentLoopEvent[] = [];

    while (checkpoint.iterations < this.maxIterations) {
      checkpoint.iterations += 1;
      let decision: AgentModelDecision;
      const modelController = new AbortController();
      const abortModel = () => modelController.abort(signal?.reason);
      const timeout = setTimeout(() => modelController.abort(new Error("模型响应超时")), this.modelTimeoutMs);
      signal?.addEventListener("abort", abortModel, { once: true });
      try {
        decision = await this.model.decide({ messages: checkpoint.messages, tools: this.tools, signal: modelController.signal });
      } catch (error) {
        // Provider/network failures must become a durable checkpoint instead of
        // leaving the run in `running` forever (or only returning a generic 500).
        // This also gives the UI a truthful, retryable terminal state.
        const message = modelController.signal.aborted && !signal?.aborted
          ? `模型响应超时（${Math.round(this.modelTimeoutMs / 1000)} 秒）`
          : error instanceof Error ? error.message : "Model request failed";
        checkpoint.status = "failed";
        checkpoint.finalText = `这次请求暂时没有完成（模型服务异常）。${message}，请稍后重试。`;
        await this.store.save(runId, checkpoint);
        return { checkpoint, events: [{ type: "assistant.message", text: checkpoint.finalText }] };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortModel);
      }
      if (decision.kind === "message") {
        checkpoint.messages.push({ role: "assistant", content: decision.text });
        events.push({ type: "assistant.message", text: decision.text });
        if (decision.finish !== false) {
          checkpoint.status = "completed";
          checkpoint.finalText = decision.text;
          events.push({ type: "completed", text: decision.text });
          await this.store.save(runId, checkpoint);
          return { checkpoint, events };
        }
        await this.store.save(runId, checkpoint);
        continue;
      }
      if (decision.kind === "ask_user") {
        checkpoint.status = "awaiting_user";
        checkpoint.messages.push({ role: "assistant", content: decision.text });
        events.push({ type: "assistant.message", text: decision.text });
        await this.store.save(runId, checkpoint);
        return { checkpoint, events };
      }
      if (decision.calls.length > 1) {
        checkpoint.messages.push({ role: "assistant", content: "", toolCalls: decision.calls });
        const message = "为保证每个工具调用都有明确结果，本轮请逐个调用工具。";
        for (const call of decision.calls) {
          checkpoint.messages.push({ role: "tool", content: JSON.stringify({ error: message }), toolCallId: call.id, toolName: call.name });
          events.push({ type: "tool.failed", callId: call.id, name: call.name, error: message });
        }
        await this.store.save(runId, checkpoint);
        continue;
      }
      checkpoint.messages.push({ role: "assistant", content: "", toolCalls: decision.calls });
      for (const call of decision.calls) {
        checkpoint.toolCallCount += 1;
        if (checkpoint.toolCallCount > this.maxToolCalls) {
          checkpoint.status = "failed";
          checkpoint.finalText = "Agent stopped after reaching its tool-call safety budget.";
          await this.store.save(runId, checkpoint);
          return { checkpoint, events };
        }
        const tool = this.tools.find((candidate) => candidate.name === call.name);
        if (!tool) {
          checkpoint.messages.push({ role: "tool", content: JSON.stringify({ error: `Unknown agent tool: ${call.name}` }), toolCallId: call.id, toolName: call.name });
          events.push({ type: "tool.failed", callId: call.id, name: call.name, error: `Unknown agent tool: ${call.name}` });
          continue;
        }
        let input: unknown;
        try {
          input = tool.inputSchema.parse(call.input);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tool input validation failed";
          checkpoint.messages.push({ role: "tool", content: JSON.stringify({ error: message }), toolCallId: call.id, toolName: call.name });
          events.push({ type: "tool.failed", callId: call.id, name: call.name, error: message });
          continue;
        }
        if (tool.requiresApproval && checkpoint.permissionMode !== "full") {
          checkpoint.pendingApproval = { callId: call.id, name: call.name, input };
          checkpoint.status = "awaiting_user";
          events.push({ type: "approval.required", callId: call.id, name: call.name, input });
          await this.store.save(runId, checkpoint);
          return { checkpoint, events };
        }
        events.push({ type: "tool.started", callId: call.id, name: call.name, input });
        try {
          const output = await tool.execute(input, { runId, callId: call.id, idempotencyKey: `${runId}:${call.id}`, attempt: checkpoint.toolCallCount, signal });
          checkpoint.messages.push({ role: "tool", content: serializeToolOutput(output), toolCallId: call.id, toolName: call.name });
          events.push({ type: "tool.completed", callId: call.id, name: call.name, output });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tool execution failed";
          checkpoint.messages.push({ role: "tool", content: JSON.stringify({ error: message }), toolCallId: call.id, toolName: call.name });
          events.push({ type: "tool.failed", callId: call.id, name: call.name, error: message });
        }
      }
      await this.store.save(runId, checkpoint);
    }
    checkpoint.status = "failed";
    checkpoint.finalText = "Agent loop stopped after reaching its safety iteration limit.";
    await this.store.save(runId, checkpoint);
    return { checkpoint, events };
  }

  async resume(runId: string, approval: "approved" | "rejected", signal?: AbortSignal): Promise<AgentLoopResult> {
    const current = await this.store.load(runId);
    const checkpoint = current?.pendingApproval && this.store.claimPendingApproval
      ? await this.store.claimPendingApproval(runId, current.pendingApproval.callId)
      : current;
    if (!checkpoint?.pendingApproval) throw new Error("No pending agent approval");
    const pending = checkpoint.pendingApproval;
    checkpoint.pendingApproval = undefined;
    checkpoint.status = "running";
    const tool = this.tools.find((candidate) => candidate.name === pending.name);
    if (!tool) throw new Error(`Unknown agent tool: ${pending.name}`);
    const input = tool.inputSchema.parse(pending.input);
    const events: AgentLoopEvent[] = [{ type: "tool.started", callId: pending.callId, name: pending.name, input }];
    if (approval === "approved") {
      try {
        const output = await tool.execute(input, { runId, callId: pending.callId, idempotencyKey: `${runId}:${pending.callId}`, attempt: checkpoint.toolCallCount, signal });
        checkpoint.messages.push({ role: "tool", content: serializeToolOutput({ approval, output }), toolCallId: pending.callId, toolName: pending.name });
        events.push({ type: "tool.completed", callId: pending.callId, name: pending.name, output });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool execution failed";
        checkpoint.messages.push({ role: "tool", content: JSON.stringify({ approval, error: message }), toolCallId: pending.callId, toolName: pending.name });
        events.push({ type: "tool.failed", callId: pending.callId, name: pending.name, error: message });
      }
    } else {
      checkpoint.messages.push({ role: "tool", content: JSON.stringify({ approval: "rejected", reason: "The user rejected this action." }), toolCallId: pending.callId, toolName: pending.name });
      events.push({ type: "tool.failed", callId: pending.callId, name: pending.name, error: "User rejected the tool call." });
    }
    await this.store.save(runId, checkpoint);
    const continuation = await this.runWithPermission(runId, "", checkpoint.permissionMode ?? "default", signal);
    return { checkpoint: continuation.checkpoint, events: [...events, ...continuation.events] };
  }
}
