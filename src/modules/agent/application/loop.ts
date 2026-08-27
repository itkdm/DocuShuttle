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
    /** Public response tokens only; never use this channel for private reasoning. */
    onTextDelta?: (text: string) => void;
  }): Promise<AgentModelDecision>;
}

export type AgentLoopCheckpoint = {
  messages: AgentLoopMessage[];
  iterations: number;
  toolCallCount: number;
  pendingApproval?: { callId: string; name: string; input: unknown };
  status: "running" | "awaiting_user" | "completed" | "failed" | "cancelled";
  finalText?: string;
  permissionMode?: AgentPermissionMode;
  /** Durable, user-visible execution trace. Kept bounded by the runner. */
  trace?: AgentLoopEvent[];
};

export type AgentLoopStore = {
  load(runId: string): Promise<AgentLoopCheckpoint | undefined>;
  save(runId: string, checkpoint: AgentLoopCheckpoint): Promise<void>;
  claimPendingApproval?(runId: string, callId: string): Promise<AgentLoopCheckpoint | undefined>;
  markCancelled?(runId: string): Promise<void>;
};

export type AgentLoopEvent = { timestamp?: string; eventId?: string } & (
  | { type: "turn.started"; text: string }
  | { type: "model.started"; text: string }
  | { type: "model.completed"; durationMs: number }
  /** Public streamed text from the provider. This is commentary while the
   * model is deciding or calling tools, never hidden chain-of-thought. */
  | { type: "model.delta"; text: string; channel?: "commentary" | "reasoning_summary" | "final" }
  | { type: "assistant.message"; text: string }
  | { type: "tool.started"; callId: string; name: string; input: unknown }
  | { type: "tool.completed"; callId: string; name: string; output: unknown }
  | { type: "tool.failed"; callId: string; name: string; error: string; durationMs?: number }
  | { type: "approval.required"; callId: string; name: string; input: unknown }
  | { type: "approval.resolved"; callId: string; name: string; decision: "approved" | "rejected" }
  | { type: "completed"; text: string }
  | { type: "turn.failed"; error: string }
  | { type: "turn.cancelled"; text: string });

export type AgentLoopResult = {
  checkpoint: AgentLoopCheckpoint;
  events: AgentLoopEvent[];
};

const serializeToolOutput = (value: unknown) => {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
};

const summarizeTraceValue = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const durationMs = typeof record.durationMs === "number" ? record.durationMs : undefined;
  if (typeof record.changedCount === "number") return { summary: `已原子更新 ${record.changedCount} 处`, revision: record.revision, validationValid: (record.validation as { valid?: unknown } | undefined)?.valid, durationMs };
  if (typeof record.nodeId === "string" && typeof record.revision === "string") {
    return "text" in record
      ? { summary: "已读取目标文本", nodeId: record.nodeId, revision: record.revision, durationMs }
      : { summary: "已生成新的文档版本", nodeId: record.nodeId, revision: record.revision, validationValid: (record.validation as { valid?: unknown } | undefined)?.valid, durationMs };
  }
  if (record.counts && typeof record.counts === "object") return { summary: "已读取文档概览", revision: record.revision, counts: record.counts, durationMs };
  if (Array.isArray(record.nodes)) return { summary: `已定位 ${record.nodes.length} 个文档节点`, revision: record.revision, durationMs };
  if (Array.isArray(record.operations) && typeof record.riskLevel === "string") return { summary: `已生成 ${record.operations.length} 项修改预演`, riskLevel: record.riskLevel, durationMs };
  if (Array.isArray(record.capabilities) && typeof record.nodeId === "string") return { summary: "已检查节点可用操作", nodeId: record.nodeId, durationMs };
  if (Array.isArray(record.documents)) return { summary: `已读取 ${record.documents.length} 份关联资料`, durationMs };
  return { summary: "工具已返回结果", durationMs };
};

export class AgentLoopRunner {
  constructor(
    private readonly model: AgentModelPort,
    private readonly store: AgentLoopStore,
    private readonly tools: readonly AgentTool[],
    private readonly maxIterations = 24,
    private readonly maxToolCalls = 48,
    private readonly modelTimeoutMs = 30_000,
  ) {}

  async run(runId: string, userText: string, signal?: AbortSignal): Promise<AgentLoopResult> {
    return this.runWithPermission(runId, userText, "default", signal);
  }

  async runWithPermission(runId: string, userText: string, permissionMode: AgentPermissionMode, signal?: AbortSignal, onEvent?: (event: AgentLoopEvent) => void): Promise<AgentLoopResult> {
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
    if (userText.trim()) {
      checkpoint.permissionMode = permissionMode;
      // Budgets are per turn. Earlier conversation remains context, but must
      // never consume a later request's safety allowance.
      checkpoint.iterations = 0;
      checkpoint.toolCallCount = 0;
    }
    else checkpoint.permissionMode ??= permissionMode;
    if ((checkpoint.status === "completed" || checkpoint.status === "failed" || checkpoint.status === "cancelled") && !userText.trim()) {
      return { checkpoint, events: checkpoint.finalText ? [{ type: "completed", text: checkpoint.finalText }] : [] };
    }
    // Do not start a second turn while a side-effect is waiting for an
    // explicit decision. The user must approve or reject the pending call so
    // its checkpoint remains the single source of truth for the run.
    if (userText.trim() && checkpoint.pendingApproval) {
      checkpoint.status = "awaiting_user";
      checkpoint.finalText = "当前有一项文档操作等待确认，请先批准或拒绝后再继续。";
      const blocked = { type: "assistant.message", text: checkpoint.finalText } as const;
      await this.store.save(runId, checkpoint);
      return { checkpoint, events: [blocked] };
    }
    if (userText.trim()) checkpoint.messages.push({ role: "user", content: userText });
    checkpoint.status = "running";
    checkpoint.finalText = undefined;
    const events: AgentLoopEvent[] = [];
    const emit = (event: AgentLoopEvent, notify = true) => {
      const timestamped = { ...event, eventId: event.eventId ?? crypto.randomUUID(), timestamp: event.timestamp ?? new Date().toISOString() } as AgentLoopEvent;
      const traceEvent = timestamped.type === "tool.started"
        ? { ...timestamped, input: summarizeTraceValue(timestamped.input) } as AgentLoopEvent
        : timestamped.type === "tool.completed"
          ? { ...timestamped, output: summarizeTraceValue(timestamped.output) } as AgentLoopEvent
          : timestamped;
      events.push(traceEvent);
      checkpoint.trace = [...(checkpoint.trace ?? []), traceEvent].slice(-200);
      if (notify) onEvent?.(traceEvent);
      return traceEvent;
    };
    if (userText.trim()) emit({ type: "turn.started", text: userText });

    while (checkpoint.iterations < this.maxIterations) {
      checkpoint.iterations += 1;
      const modelStartedEvent = emit({ type: "model.started", text: "正在整理下一步" }, false);
      // Persist the observable boundary before entering a potentially long
      // provider call so a refresh can recover the real in-flight phase.
      await this.store.save(runId, checkpoint);
      onEvent?.(modelStartedEvent);
      const modelStartedAt = Date.now();
      let decision: AgentModelDecision;
      const modelController = new AbortController();
      const abortModel = () => modelController.abort(signal?.reason);
      const timeout = setTimeout(() => modelController.abort(new Error("模型响应超时")), this.modelTimeoutMs);
      signal?.addEventListener("abort", abortModel, { once: true });
      try {
        decision = await this.model.decide({ messages: checkpoint.messages, tools: this.tools, signal: modelController.signal, onTextDelta: (text) => emit({ type: "model.delta", text, channel: "commentary" }) });
      } catch (error) {
        // Provider/network failures must become a durable checkpoint instead of
        // leaving the run in `running` forever (or only returning a generic 500).
        // This also gives the UI a truthful, retryable terminal state.
        const message = modelController.signal.aborted && !signal?.aborted
          ? `模型响应超时（${Math.round(this.modelTimeoutMs / 1000)} 秒）`
          : error instanceof Error ? error.message : "Model request failed";
        checkpoint.status = "failed";
        checkpoint.finalText = `这次请求暂时没有完成（模型服务异常）。${message}，请稍后重试。`;
        const failureMessage = emit({ type: "assistant.message", text: checkpoint.finalText }, false);
        const failureEvent = emit({ type: "turn.failed", error: checkpoint.finalText }, false);
        await this.store.save(runId, checkpoint);
        onEvent?.(failureMessage); onEvent?.(failureEvent);
        return { checkpoint, events };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortModel);
      }
      emit({ type: "model.completed", durationMs: Date.now() - modelStartedAt });
      if (decision.kind === "message") {
        checkpoint.messages.push({ role: "assistant", content: decision.text });
        emit({ type: "assistant.message", text: decision.text });
        if (decision.finish !== false) {
          checkpoint.status = "completed";
          checkpoint.finalText = decision.text;
          emit({ type: "completed", text: decision.text });
          await this.store.save(runId, checkpoint);
          return { checkpoint, events };
        }
        await this.store.save(runId, checkpoint);
        continue;
      }
      if (decision.kind === "ask_user") {
        checkpoint.status = "awaiting_user";
        checkpoint.messages.push({ role: "assistant", content: decision.text });
        emit({ type: "assistant.message", text: decision.text });
        await this.store.save(runId, checkpoint);
        return { checkpoint, events };
      }
      for (const call of decision.calls) {
        checkpoint.toolCallCount += 1;
        if (checkpoint.toolCallCount > this.maxToolCalls) {
          checkpoint.status = "failed";
          checkpoint.finalText = "Agent stopped after reaching its tool-call safety budget.";
          await this.store.save(runId, checkpoint);
          const failureMessage = emit({ type: "assistant.message", text: checkpoint.finalText }, false);
          const failureEvent = emit({ type: "turn.failed", error: checkpoint.finalText }, false);
          await this.store.save(runId, checkpoint);
          onEvent?.(failureMessage); onEvent?.(failureEvent);
          return { checkpoint, events };
        }
        // Keep each assistant tool-call message paired with the result that
        // follows it. If a later call needs approval, calls after that
        // boundary are intentionally left for the next model decision rather
        // than persisting unpaired tool-call IDs into the transcript.
        checkpoint.messages.push({ role: "assistant", content: "", toolCalls: [call] });
        const tool = this.tools.find((candidate) => candidate.name === call.name);
        if (!tool) {
          checkpoint.messages.push({ role: "tool", content: JSON.stringify({ error: `Unknown agent tool: ${call.name}` }), toolCallId: call.id, toolName: call.name });
          emit({ type: "tool.failed", callId: call.id, name: call.name, error: `Unknown agent tool: ${call.name}` });
          continue;
        }
        let input: unknown;
        try {
          input = tool.inputSchema.parse(call.input);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tool input validation failed";
          checkpoint.messages.push({ role: "tool", content: JSON.stringify({ error: message }), toolCallId: call.id, toolName: call.name });
          emit({ type: "tool.failed", callId: call.id, name: call.name, error: message });
          continue;
        }
        if (tool.requiresApproval && checkpoint.permissionMode !== "full") {
          checkpoint.pendingApproval = { callId: call.id, name: call.name, input };
          checkpoint.status = "awaiting_user";
          const approvalEvent = emit({ type: "approval.required", callId: call.id, name: call.name, input }, false);
          await this.store.save(runId, checkpoint);
          onEvent?.(approvalEvent);
          return { checkpoint, events };
        }
        const toolStartedEvent = emit({ type: "tool.started", callId: call.id, name: call.name, input }, false);
        // Make the side-effect boundary durable before executing the tool.
        // This is what lets recovery distinguish an in-flight operation from
        // a run that has not reached the tool yet.
        await this.store.save(runId, checkpoint);
        onEvent?.(toolStartedEvent);
        const toolStartedAt = Date.now();
        try {
          const output = await tool.execute(input, { runId, callId: call.id, idempotencyKey: `${runId}:${call.id}`, attempt: checkpoint.toolCallCount, signal });
          checkpoint.messages.push({ role: "tool", content: serializeToolOutput(output), toolCallId: call.id, toolName: call.name });
          const toolCompletedEvent = emit({ type: "tool.completed", callId: call.id, name: call.name, output: { ...((output && typeof output === "object") ? output : { value: output }), durationMs: Date.now() - toolStartedAt } }, false);
          await this.store.save(runId, checkpoint);
          onEvent?.(toolCompletedEvent);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tool execution failed";
          checkpoint.messages.push({ role: "tool", content: JSON.stringify({ error: message }), toolCallId: call.id, toolName: call.name });
          const toolFailedEvent = emit({ type: "tool.failed", callId: call.id, name: call.name, error: message, durationMs: Date.now() - toolStartedAt }, false);
          await this.store.save(runId, checkpoint);
          onEvent?.(toolFailedEvent);
        }
      }
      await this.store.save(runId, checkpoint);
    }
    checkpoint.status = "failed";
    checkpoint.finalText = "本轮操作未能在安全步数内完成。已保留已完成的读取结果，未提交未确认的写入；请缩小范围后重试。";
    const terminalMessage = emit({ type: "assistant.message", text: checkpoint.finalText }, false);
    const terminalFailure = emit({ type: "turn.failed", error: checkpoint.finalText }, false);
    await this.store.save(runId, checkpoint);
    onEvent?.(terminalMessage); onEvent?.(terminalFailure);
    return { checkpoint, events };
  }

  async resume(runId: string, approval: "approved" | "rejected", signal?: AbortSignal, onEvent?: (event: AgentLoopEvent) => void): Promise<AgentLoopResult> {
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
    const events: AgentLoopEvent[] = [];
    const emit = (event: AgentLoopEvent, notify = true) => {
      const traceEvent = { ...event, eventId: event.eventId ?? crypto.randomUUID(), timestamp: event.timestamp ?? new Date().toISOString() } as AgentLoopEvent;
      events.push(traceEvent);
      checkpoint.trace = [...(checkpoint.trace ?? []), traceEvent].slice(-200);
      if (notify) onEvent?.(traceEvent);
      return traceEvent;
    };
    const approvalEvent = emit({ type: "approval.resolved", callId: pending.callId, name: pending.name, decision: approval }, false);
    await this.store.save(runId, checkpoint);
    onEvent?.(approvalEvent);
    if (approval === "approved") {
      const startedEvent = emit({ type: "tool.started", callId: pending.callId, name: pending.name, input: summarizeTraceValue(input) }, false);
      // Persist the approval claim and the operation start before side effects.
      // If the request is interrupted, the trace tells us exactly whether a
      // write was started, completed, or needs safe investigation.
      await this.store.save(runId, checkpoint);
      onEvent?.(startedEvent);
      const toolStartedAt = Date.now();
      try {
        const output = await tool.execute(input, { runId, callId: pending.callId, idempotencyKey: `${runId}:${pending.callId}`, attempt: checkpoint.toolCallCount, signal });
        checkpoint.messages.push({ role: "tool", content: serializeToolOutput({ approval, output }), toolCallId: pending.callId, toolName: pending.name });
        const completedEvent = emit({ type: "tool.completed", callId: pending.callId, name: pending.name, output: summarizeTraceValue({ ...((output && typeof output === "object") ? output : { value: output }), durationMs: Date.now() - toolStartedAt }) }, false);
        await this.store.save(runId, checkpoint);
        onEvent?.(completedEvent);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool execution failed";
        checkpoint.messages.push({ role: "tool", content: JSON.stringify({ approval, error: message }), toolCallId: pending.callId, toolName: pending.name });
        const failedEvent = emit({ type: "tool.failed", callId: pending.callId, name: pending.name, error: message, durationMs: Date.now() - toolStartedAt }, false);
        await this.store.save(runId, checkpoint);
        onEvent?.(failedEvent);
      }
    } else {
      checkpoint.messages.push({ role: "tool", content: JSON.stringify({ approval: "rejected", reason: "The user rejected this action." }), toolCallId: pending.callId, toolName: pending.name });
      const rejectedEvent = emit({ type: "tool.failed", callId: pending.callId, name: pending.name, error: "User rejected the tool call." }, false);
      await this.store.save(runId, checkpoint);
      onEvent?.(rejectedEvent);
    }
    await this.store.save(runId, checkpoint);
    const continuation = await this.runWithPermission(runId, "", checkpoint.permissionMode ?? "default", signal, onEvent);
    return { checkpoint: continuation.checkpoint, events: [...events, ...continuation.events] };
  }
}
