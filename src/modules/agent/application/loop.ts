import { z } from "zod";
import { compactAgentMessages, DEFAULT_AGENT_CONTEXT_COMPACTION_POLICY, type AgentContextCompactionPolicy } from "./context-compaction";
import { createAgentEvent, shouldPersistAgentEvent, type AgentEvent, type AgentEventPayload } from "./events";
import type { AgentConversationContextPort } from "./ports";
import type { AgentClientToolResult, AgentInteractionResolution, AgentRuntimePendingInteraction } from "../domain/model";
import type { AgentImageAttachment } from "./message-parts";
import { describeAgentImages } from "./message-parts";

const sameImageAttachments = (left: readonly AgentImageAttachment[], right: readonly AgentImageAttachment[]) => left.length === right.length && left.every((image, index) => image.assetId === right[index]?.assetId && image.mimeType === right[index]?.mimeType);

export type AgentLoopMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ReadonlyArray<{ id: string; name: string; input: unknown }>;
  /** Private provider continuation state; never expose this to users. */
  reasoning?: string;
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
  /** Client-only tools pause the durable run until the browser returns a safe result. */
  clientExecution?: boolean;
  execute(input: z.infer<TSchema>, context: AgentToolContext): Promise<unknown>;
};

export type AgentModelDecision =
  | { kind: "message"; text: string; finish?: boolean; reasoning?: string }
  | { kind: "tool_calls"; calls: ReadonlyArray<{ id: string; name: string; input: unknown }>; text?: string; reasoning?: string }
  | { kind: "ask_user"; text: string; reasoning?: string };

/** Controls how much autonomy the user grants to this run. */
export type AgentPermissionMode = "default" | "full";

export interface AgentModelPort {
  decide(input: {
    messages: readonly AgentLoopMessage[];
    tools: readonly AgentTool[];
    signal?: AbortSignal;
    /** Public response tokens only; never use this channel for private reasoning. */
    onTextDelta?: (text: string) => void;
    /** Server-internal provider liveness; never becomes an AgentEvent. */
    onStreamActivity?: () => void;
  }): Promise<AgentModelDecision>;
}

export type AgentLoopCheckpoint = {
  /** Stable conversation/thread identity shared by immutable execution runs. */
  conversationId?: string;
  messages: AgentLoopMessage[];
  iterations: number;
  toolCallCount: number;
  pendingInteraction?: AgentRuntimePendingInteraction;
  pendingResolution?: AgentInteractionResolution;
  status: "running" | "awaiting_approval" | "awaiting_user" | "awaiting_client" | "completed" | "failed" | "cancelled";
  finalText?: string;
  permissionMode?: AgentPermissionMode;
};

/** Normalize checkpoints at persistence boundaries and discard pre-separation activity data. */
export const normalizeAgentLoopCheckpoint = (raw: unknown): AgentLoopCheckpoint | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const checkpoint = { ...(raw as Record<string, unknown>) };
  delete checkpoint["trace"];
  return checkpoint as AgentLoopCheckpoint;
};

export type AgentLoopStore = {
  load(runId: string): Promise<AgentLoopCheckpoint | undefined>;
  save(runId: string, checkpoint: AgentLoopCheckpoint): Promise<void>;
  /** Atomically persist a checkpoint with one semantic assistant message. */
  saveWithAssistantMessage(runId: string, checkpoint: AgentLoopCheckpoint, message: { messageKey: string; text: string }): Promise<void>;
  /** Append execution facts independently from the recovery snapshot. */
  appendEvents?(runId: string, events: readonly AgentEvent[]): Promise<void>;
  /** Persist only user-visible conversation semantics, never tool transcripts. */
  appendAssistantMessage?(runId: string, message: { id: string; text: string }): Promise<void>;
  appendUserMessage?(runId: string, message: { id: string; text: string; images?: readonly AgentImageAttachment[] }): Promise<void>;
  /** Durable result for a side effect, keyed by runId:callId. */
  loadEffectReceipt?(runId: string, idempotencyKey: string): Promise<AgentEffectReceipt | undefined>;
  saveEffectReceipt?(runId: string, receipt: AgentEffectReceipt): Promise<AgentEffectReceipt>;
  /** Refresh the server-side lease while a provider/tool call is in flight. */
  heartbeat?(runId: string): Promise<boolean>;
  claimRecovery?(runId: string): Promise<AgentLoopCheckpoint | undefined>;
  releaseLeaseForRecovery?(runId: string): Promise<void>;
  resolvePendingApproval?(runId: string, interactionId: string, callId: string, decision: "approved" | "rejected"): Promise<AgentLoopCheckpoint | undefined>;
  resolvePendingUserInput?(runId: string, interactionId: string, message: { id: string; text: string; images?: readonly AgentImageAttachment[] }): Promise<AgentLoopCheckpoint | undefined>;
  resolvePendingClientTool?(runId: string, interactionId: string, callId: string, result: AgentClientToolResult): Promise<AgentLoopCheckpoint | undefined>;
  markCancelled?(runId: string): Promise<void>;
};

export type AgentEffectReceipt = {
  idempotencyKey: string;
  callId: string;
  toolName: string;
  output: unknown;
  completedAt: string;
};

export const AGENT_LEASE_MANAGED_STATUSES = ["queued", "running"] as const;

export type { AgentEvent, AgentEventPayload } from "./events";

export type AgentLoopResult = {
  checkpoint: AgentLoopCheckpoint;
  events: AgentEvent[];
};

type AssistantMessageEvent = Extract<AgentEvent, { type: "assistant.message" }>;

export type AgentEngineeringEvent = {
  event: string;
  metadata: Record<string, unknown>;
};

export const TRANSPORT_INTERRUPTED = "TRANSPORT_INTERRUPTED";
export type AgentModelTimeoutKind = "MODEL_IDLE_TIMEOUT" | "MODEL_MAX_DURATION_EXCEEDED";

export class AgentModelTimeoutError extends Error {
  constructor(public readonly timeoutKind: AgentModelTimeoutKind) {
    super(timeoutKind);
    this.name = timeoutKind;
  }
}

export class AgentModelOutputBudgetExceededError extends Error {
  constructor() {
    super("MODEL_OUTPUT_BUDGET_EXCEEDED");
    this.name = "MODEL_OUTPUT_BUDGET_EXCEEDED";
  }
}

export type ToolInputValidationIssue = {
  path: string;
  code: string;
  message: string;
  maximum?: number;
  minimum?: number;
};

export type ToolInputValidationError = {
  error: "TOOL_INPUT_VALIDATION_FAILED";
  issues: ToolInputValidationIssue[];
};

export const formatToolInputValidationError = (error: unknown): ToolInputValidationError | undefined => {
  if (!(error instanceof z.ZodError)) return undefined;
  return {
    error: "TOOL_INPUT_VALIDATION_FAILED",
    issues: error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.length ? issue.path.join(".") : "input",
      code: issue.code,
      message: issue.message,
      ...(("maximum" in issue && typeof issue.maximum === "number") ? { maximum: issue.maximum } : {}),
      ...(("minimum" in issue && typeof issue.minimum === "number") ? { minimum: issue.minimum } : {}),
    })),
  };
};

const compactForModel = (value: unknown, depth = 0): unknown => {
  if (depth > 5) return "[内容已省略]";
  if (typeof value === "string") return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => compactForModel(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 60).map(([key, entry]) => [key, compactForModel(entry, depth + 1)]));
  }
  return value;
};

const serializeToolOutput = (value: unknown) => {
  const encoded = JSON.stringify(compactForModel(value));
  return encoded === undefined ? "null" : encoded;
};

const compactPersistedToolContent = (content: string) => {
  try { return serializeToolOutput(JSON.parse(content)); }
  catch { return content.length > 4_000 ? `${content.slice(0, 4_000)}…` : content; }
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

const withDefined = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

export const projectToolOutputForEvent = (toolName: string, output: unknown): unknown => {
  const record = output && typeof output === "object" && !Array.isArray(output) ? output as Record<string, unknown> : undefined;
  if (!record) return summarizeTraceValue(output);
  const durationMs = typeof record.durationMs === "number" ? record.durationMs : undefined;
  if (toolName === "generate_image") {
    return withDefined({ summary: "已生成图片", assetId: record.assetId, mimeType: record.mimeType, sha256: record.sha256, purpose: record.purpose, referenceCount: record.referenceCount, durationMs });
  }
  if (toolName === "inspect_image") {
    const analysis = record.analysis && typeof record.analysis === "object" && !Array.isArray(record.analysis) ? record.analysis as Record<string, unknown> : undefined;
    return withDefined({ summary: "已分析图片", source: record.source, assetId: record.assetId, nodeId: record.nodeId, sourceFileId: record.sourceFileId, revision: record.revision, mimeType: record.mimeType, byteLength: record.byteLength, analysis: analysis && withDefined({ summary: analysis.summary, type: analysis.type, style: analysis.style, visibleText: Array.isArray(analysis.visibleText) ? analysis.visibleText.slice(0, 3) : undefined }), durationMs });
  }
  if (toolName === "replace_document_image") {
    return withDefined({ summary: "已替换文档图片", targetNodeId: record.targetNodeId, assetId: record.assetId, previousRevision: record.previousRevision, revision: record.revision, changedEntries: record.changedEntries, validation: record.validation, durationMs });
  }
  return summarizeTraceValue(output);
};

export class AgentLoopRunner {
  constructor(
    private readonly model: AgentModelPort,
    private readonly store: AgentLoopStore,
    private readonly tools: readonly AgentTool[],
    private readonly maxIterations = 24,
    private readonly maxToolCalls = 48,
    private readonly modelIdleTimeoutMs = 30_000,
    private readonly contextCompactionPolicy: AgentContextCompactionPolicy = DEFAULT_AGENT_CONTEXT_COMPACTION_POLICY,
    private readonly heartbeatIntervalMs = 30_000,
    private readonly onEngineeringEvent?: (event: AgentEngineeringEvent) => void,
    private readonly conversationContext?: AgentConversationContextPort,
    private readonly modelMaxDurationMs = 120_000,
  ) {}

  private observe(runId: string, event: AgentEvent, permissionMode?: AgentPermissionMode) {
    if (!this.onEngineeringEvent || event.type === "model.delta" || event.type === "assistant.message") return;
    const metadata: Record<string, unknown> = { runId };
    if ("callId" in event) metadata.callId = event.callId;
    if ("name" in event) metadata.toolName = event.name;
    if ("durationMs" in event && event.durationMs !== undefined) metadata.durationMs = event.durationMs;
    if (event.type === "approval.resolved") metadata.decision = event.decision;
    if (event.type === "tool.started" || event.type === "approval.required" || event.type === "approval.resolved") {
      metadata.permissionMode = permissionMode;
      metadata.approvalMode = permissionMode === "full" ? "automatic" : "manual";
    }
    this.onEngineeringEvent({ event: `agent.${event.type}`, metadata });
  }

  private async withLeaseHeartbeat<T>(runId: string, operation: () => Promise<T>, options: { skipInitialBeat?: boolean } = {}): Promise<T> {
    if (!this.store.heartbeat) return operation();
    const beat = () => this.store.heartbeat!(runId).catch(() => false);
    if (!options.skipInitialBeat) await beat();
    const timer = setInterval(() => { void beat(); }, this.heartbeatIntervalMs);
    try { return await operation(); }
    finally { clearInterval(timer); }
  }

  private async throwForTransportInterruption(runId: string, signal?: AbortSignal): Promise<never> {
    if (!signal?.aborted) throw new Error("Tool execution failed");
    const latest = await this.store.load(runId);
    if (latest?.status === "cancelled") throw new Error("RUN_CANCELLED");
    await this.store.releaseLeaseForRecovery?.(runId);
    throw new Error(TRANSPORT_INTERRUPTED);
  }

  private findUnresolvedToolCall(checkpoint: AgentLoopCheckpoint) {
    const completed = new Set(checkpoint.messages.filter((message) => message.role === "tool" && message.toolCallId).map((message) => message.toolCallId));
    return checkpoint.messages
      .filter((message) => message.role === "assistant" && message.toolCalls)
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => !completed.has(call.id));
  }

  private async reconcileEffectReceiptAfterToolError(runId: string, idempotencyKey: string): Promise<AgentEffectReceipt | undefined> {
    return this.store.loadEffectReceipt?.(runId, idempotencyKey);
  }

  private async recoverUnfinishedTool(runId: string, checkpoint: AgentLoopCheckpoint, signal?: AbortSignal, onEvent?: (event: AgentEvent) => void): Promise<void> {
    const call = this.findUnresolvedToolCall(checkpoint);
    if (!call) return;
    if (signal?.aborted) await this.throwForTransportInterruption(runId, signal);
    const tool = this.tools.find((candidate) => candidate.name === call.name);
    if (!tool) throw new Error(`Unknown agent tool: ${call.name}`);
    const input = tool.inputSchema.parse(call.input);
    const idempotencyKey = `${runId}:${call.id}`;
    const existingReceipt = await this.store.loadEffectReceipt?.(runId, idempotencyKey);
    let output: unknown;
    let failed: string | undefined;
    if (existingReceipt) output = existingReceipt.output;
    else {
      try {
        output = await this.withLeaseHeartbeat(runId, () => tool.execute(input, { runId, callId: call.id, idempotencyKey, attempt: checkpoint.toolCallCount, signal }));
        if (signal?.aborted) await this.throwForTransportInterruption(runId, signal);
        if (this.store.saveEffectReceipt) await this.store.saveEffectReceipt(runId, { idempotencyKey, callId: call.id, toolName: call.name, output, completedAt: new Date().toISOString() });
      } catch (error) {
        if (signal?.aborted) await this.throwForTransportInterruption(runId, signal);
        const reconciledReceipt = await this.reconcileEffectReceiptAfterToolError(runId, idempotencyKey);
        if (reconciledReceipt) output = reconciledReceipt.output;
        else failed = error instanceof Error ? error.message : "Tool execution failed";
      }
    }
    checkpoint.messages.push({ role: "tool", content: failed ? JSON.stringify({ error: failed }) : serializeToolOutput(output), toolCallId: call.id, toolName: call.name });
    const event = failed
      ? createAgentEvent(runId, { type: "tool.failed", callId: call.id, name: call.name, error: failed })
      : createAgentEvent(runId, { type: "tool.completed", callId: call.id, name: call.name, output: projectToolOutputForEvent(call.name, output) });
    checkpoint.status = "running";
    await this.store.save(runId, checkpoint);
    try { await this.store.appendEvents?.(runId, [event]); } catch { this.onEngineeringEvent?.({ event: "agent.event.persist_failed", metadata: { runId, eventId: event.eventId, eventType: event.type } }); }
    onEvent?.(event);
  }

  async run(runId: string, userText: string, signal?: AbortSignal): Promise<AgentLoopResult> {
    return this.runWithPermission(runId, userText, "default", signal);
  }

  async recover(runId: string, signal?: AbortSignal, onEvent?: (event: AgentEvent) => void): Promise<AgentLoopResult> {
    const current = await this.store.load(runId);
    if (!current) throw new Error("RUN_NOT_FOUND");
    if (current.status !== "running") return { checkpoint: current, events: [] };
    if (this.store.claimRecovery) {
      const claimed = await this.store.claimRecovery(runId);
      if (!claimed) {
        const latest = await this.store.load(runId);
        return { checkpoint: latest ?? current, events: [] };
      }
    }
    const latest = await this.store.load(runId);
    if (latest?.pendingResolution?.type === "approval") {
      return this.resume(runId, latest.pendingResolution.decision, latest.pendingResolution.interactionId, latest.pendingResolution.callId, signal, onEvent);
    }
    if (latest?.pendingResolution?.type === "user_input") {
      return this.runWithPermission(runId, latest.pendingResolution.text, latest.permissionMode ?? "default", signal, onEvent, latest.pendingResolution.messageId, latest.pendingResolution.interactionId);
    }
    if (latest?.pendingResolution?.type === "client_tool") {
      return this.resumeClientTool(runId, latest.pendingResolution.interactionId, latest.pendingResolution.callId, latest.pendingResolution.result, signal, onEvent);
    }
    if (latest) await this.recoverUnfinishedTool(runId, latest, signal, onEvent);
    return this.runWithPermission(runId, "", current.permissionMode ?? "default", signal, onEvent);
  }

  async runWithPermission(runId: string, userText: string, permissionMode: AgentPermissionMode, signal?: AbortSignal, onEvent?: (event: AgentEvent) => void, clientMessageId?: string, interactionId?: string, userAttachments: readonly AgentImageAttachment[] = []): Promise<AgentLoopResult> {
    const current = await this.store.load(runId);
    const isFreshRun = !current;
    let checkpoint: AgentLoopCheckpoint = current ?? {
      messages: [],
      iterations: 0,
      toolCallCount: 0,
      status: "running",
      permissionMode,
    };
    if (isFreshRun && this.conversationContext) {
      const context = await this.conversationContext.loadPriorMessages(runId);
      checkpoint.conversationId = context.conversationId;
      checkpoint.messages = compactAgentMessages(context.messages, this.contextCompactionPolicy).messages;
      if (context.truncated) {
        this.onEngineeringEvent?.({ event: "agent.context.history_truncated", metadata: { runId, conversationId: context.conversationId, loadedCount: context.loadedCount, limit: context.limit } });
      }
    }
    let turnText = userText;
    const existingUserResolution = checkpoint.pendingResolution?.type === "user_input" ? checkpoint.pendingResolution : undefined;
    let effectiveAttachments = userAttachments;
    if (existingUserResolution) {
      if (!interactionId || interactionId !== existingUserResolution.interactionId) throw new Error("USER_INPUT_INTERACTION_MISMATCH");
      if (userText.trim() && userText !== existingUserResolution.text) throw new Error("USER_INPUT_RESOLUTION_MISMATCH");
      if (userAttachments.length && !sameImageAttachments(userAttachments, existingUserResolution.images ?? [])) throw new Error("USER_INPUT_RESOLUTION_MISMATCH");
      turnText = existingUserResolution.text;
      effectiveAttachments = existingUserResolution.images ?? [];
    }
    const hasUserInput = turnText.trim().length > 0 || effectiveAttachments.length > 0;
    const modelAttachmentDescription = describeAgentImages(effectiveAttachments);
    if (hasUserInput && interactionId && !checkpoint.pendingInteraction && !existingUserResolution) throw new Error("USER_INPUT_ALREADY_CLAIMED");
    // Older checkpoints may contain an unbounded region listing or tool
    // payload. Compact those messages before sending them back to a provider;
    // this keeps continuation requests reliable without changing the durable
    // recovery transcript.
    checkpoint.messages = checkpoint.messages.map((message) => message.role === "tool"
      ? { ...message, content: compactPersistedToolContent(message.content) }
      : message);
    // A pending side effect is a hard interaction boundary. Check it before
    // changing permission, counters, or appending a new turn; a normal user
    // request must not mutate the approval checkpoint.
    if (hasUserInput && checkpoint.pendingInteraction?.type === "approval") {
      return {
        checkpoint,
        events: [createAgentEvent(runId, { type: "assistant.message", text: "当前有一项文档操作等待确认，请先批准或拒绝后再继续。" })],
      };
    }
    if (!hasUserInput && checkpoint.pendingInteraction) return { checkpoint, events: [] };
    if (hasUserInput && checkpoint.pendingInteraction?.type === "user_input") {
      if (!interactionId || interactionId !== checkpoint.pendingInteraction.interactionId) throw new Error("USER_INPUT_INTERACTION_MISMATCH");
      const message = { id: clientMessageId ?? crypto.randomUUID(), text: turnText, images: effectiveAttachments };
      const claimed = this.store.resolvePendingUserInput
        ? await this.store.resolvePendingUserInput(runId, interactionId, message)
        : { ...checkpoint, pendingResolution: { interactionId, type: "user_input" as const, messageId: message.id, text: message.text, ...(message.images?.length ? { images: message.images } : {}) }, status: "running" as const };
      if (!claimed) throw new Error("USER_INPUT_ALREADY_CLAIMED");
      checkpoint = claimed;
      checkpoint.pendingInteraction = undefined;
      checkpoint.status = "running";
      await this.store.appendUserMessage?.(runId, message);
    }
    if (hasUserInput && existingUserResolution) {
      // A request can die after the resolution RPC but before the conversation
      // row is materialized. Replaying this idempotent write repairs that
      // durable projection before the inbox item is consumed.
      await this.store.appendUserMessage?.(runId, { id: existingUserResolution.messageId, text: existingUserResolution.text, images: existingUserResolution.images });
    }
    if (isFreshRun) {
      checkpoint.permissionMode = permissionMode;
      checkpoint.iterations = 0;
      checkpoint.toolCallCount = 0;
    } else {
      checkpoint.permissionMode ??= permissionMode;
    }
    if ((checkpoint.status === "completed" || checkpoint.status === "failed" || checkpoint.status === "cancelled") && !hasUserInput) {
      if (!checkpoint.finalText) return { checkpoint, events: [] };
      const terminalEvent = checkpoint.status === "completed"
        ? createAgentEvent(runId, { type: "turn.completed", text: checkpoint.finalText })
        : checkpoint.status === "failed"
          ? createAgentEvent(runId, { type: "turn.failed", error: checkpoint.finalText })
          : createAgentEvent(runId, { type: "turn.cancelled", text: checkpoint.finalText });
      return { checkpoint, events: [terminalEvent] };
    }
    if (hasUserInput) {
      // An answer to ask_user continues the same checkpoint and therefore
      // carries the question's preceding context into the next model call.
      checkpoint.messages.push({ role: "user", content: `${turnText}${modelAttachmentDescription}` });
      checkpoint.pendingResolution = undefined;
    }
    checkpoint.status = "running";
    checkpoint.finalText = undefined;
    const events: AgentEvent[] = [];
    const durableEvents: AgentEvent[] = [];
    let publicCommentary = "";
    let eventPersistenceChain = Promise.resolve();
    const flushDurableEvents = () => {
      if (!durableEvents.length || !this.store.appendEvents) return eventPersistenceChain;
      const batch = durableEvents.splice(0, durableEvents.length);
      eventPersistenceChain = eventPersistenceChain.then(async () => {
        try {
          await this.store.appendEvents!(runId, batch);
        } catch {
          for (const event of batch) {
            this.onEngineeringEvent?.({ event: "agent.event.persist_failed", metadata: { runId, eventId: event.eventId, eventType: event.type } });
          }
        }
      });
      return eventPersistenceChain;
    };
    const saveCheckpoint = async () => {
      await this.store.save(runId, checkpoint);
      void flushDurableEvents();
    };
    const persistDurableEvent = (event: AgentEventPayload) => {
      durableEvents.push(createAgentEvent(runId, event));
    };
    const emit = (event: AgentEventPayload, notify = true) => {
      const timestamped = createAgentEvent(runId, event);
      const activityEvent = timestamped.type === "tool.started"
        ? { ...timestamped, input: summarizeTraceValue(timestamped.input) } as AgentEvent
        : timestamped.type === "tool.completed"
          ? { ...timestamped, output: projectToolOutputForEvent(timestamped.name, timestamped.output) } as AgentEvent
          : timestamped;
      events.push(activityEvent);
      this.observe(runId, activityEvent, checkpoint.permissionMode);
      if (shouldPersistAgentEvent(activityEvent)) durableEvents.push(activityEvent);
      if (notify) onEvent?.(activityEvent);
      return activityEvent;
    };
    const persistAssistantMessage = async (messageEvent: AgentEvent) => {
      if (messageEvent.type !== "assistant.message") throw new Error("ASSISTANT_MESSAGE_EVENT_REQUIRED");
      await this.store.saveWithAssistantMessage(runId, checkpoint, { messageKey: `assistant:${messageEvent.eventId}`, text: messageEvent.text });
      await flushDurableEvents();
      onEvent?.(messageEvent);
    };
    if (isFreshRun && userText.trim()) emit({ type: "turn.started", text: userText, ...(clientMessageId ? { clientMessageId } : {}) });

    while (checkpoint.iterations < this.maxIterations) {
      checkpoint.iterations += 1;
      const modelStartedEvent = emit({ type: "model.started", text: "正在处理请求" }, false);
      const context = compactAgentMessages(checkpoint.messages, this.contextCompactionPolicy);
      if (context.compacted) {
        // Keep the checkpoint and the provider-facing transcript aligned. The
        // Only the provider-facing transcript is summarized when it exceeds
        // the policy; activity history lives in the durable event store.
        checkpoint.messages = context.messages;
      }
      // Persist the observable boundary before entering a potentially long
      // provider call so a refresh can recover the real in-flight phase.
      await saveCheckpoint();
      onEvent?.(modelStartedEvent);
      if (signal?.aborted) {
        const cancelled = await this.store.load(runId);
        if (cancelled?.status === "cancelled") return { checkpoint: cancelled, events };
        await this.store.releaseLeaseForRecovery?.(runId);
        throw new Error(TRANSPORT_INTERRUPTED);
      }
      const modelStartedAt = Date.now();
      publicCommentary = "";
      let decision: AgentModelDecision;
      const modelController = new AbortController();
      let timeoutKind: AgentModelTimeoutKind | undefined;
      let idleTimeout: ReturnType<typeof setTimeout> | undefined;
      const abortModel = () => modelController.abort(signal?.reason);
      const abortForTimeout = (kind: AgentModelTimeoutKind) => {
        timeoutKind = kind;
        modelController.abort(new AgentModelTimeoutError(kind));
      };
      const resetIdleTimeout = () => {
        if (idleTimeout) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => abortForTimeout("MODEL_IDLE_TIMEOUT"), this.modelIdleTimeoutMs);
      };
      resetIdleTimeout();
      const maxDurationTimeout = setTimeout(() => abortForTimeout("MODEL_MAX_DURATION_EXCEEDED"), this.modelMaxDurationMs);
      signal?.addEventListener("abort", abortModel, { once: true });
      try {
        decision = await this.withLeaseHeartbeat(runId, () => this.model.decide({ messages: context.messages, tools: this.tools, signal: modelController.signal, onTextDelta: (text) => { publicCommentary += text; emit({ type: "model.delta", text, channel: "commentary" }); }, onStreamActivity: resetIdleTimeout }), { skipInitialBeat: true });
      } catch (error) {
        if (signal?.aborted) {
          const cancelled = await this.store.load(runId);
          if (cancelled?.status === "cancelled") return { checkpoint: cancelled, events };
          await this.store.releaseLeaseForRecovery?.(runId);
          throw new Error(TRANSPORT_INTERRUPTED);
        }
        // Provider/network failures must become a durable checkpoint instead of
        // leaving the run in `running` forever (or only returning a generic 500).
        // This also gives the UI a truthful, retryable terminal state.
        const modelTimeout = timeoutKind ?? (error instanceof AgentModelTimeoutError ? error.timeoutKind : undefined);
        const message = modelTimeout === "MODEL_IDLE_TIMEOUT"
          ? `模型响应超时：连续 ${Math.round(this.modelIdleTimeoutMs / 1000)} 秒没有响应`
          : modelTimeout === "MODEL_MAX_DURATION_EXCEEDED"
            ? `模型响应超时：执行超过 ${Math.round(this.modelMaxDurationMs / 1000)} 分钟安全上限`
            : error instanceof AgentModelOutputBudgetExceededError
              ? "模型本次输出超过安全上限，请缩小任务范围后重试。"
              : error instanceof Error ? error.message : "Model request failed";
        const safeMessage = /No output generated|stream for errors|fetch failed|ECONN|ETIMEDOUT/i.test(message)
          ? "模型暂时没有返回有效结果"
          : message.length > 240 ? `${message.slice(0, 240)}…` : message;
        checkpoint.status = "failed";
        checkpoint.finalText = error instanceof AgentModelOutputBudgetExceededError
          ? safeMessage
          : `这次请求暂时没有完成（模型服务异常）。${safeMessage}，请稍后重试。`;
        const failureMessage = emit({ type: "assistant.message", text: checkpoint.finalText }, false) as AssistantMessageEvent;
        const failureEvent = emit({ type: "turn.failed", error: checkpoint.finalText }, false);
        await this.store.saveWithAssistantMessage(runId, checkpoint, { messageKey: `assistant:${failureMessage.eventId}`, text: failureMessage.text });
        await flushDurableEvents();
        onEvent?.(failureMessage); onEvent?.(failureEvent);
        return { checkpoint, events };
      } finally {
        if (idleTimeout) clearTimeout(idleTimeout);
        clearTimeout(maxDurationTimeout);
        signal?.removeEventListener("abort", abortModel);
      }
      emit({ type: "model.completed", durationMs: Date.now() - modelStartedAt });
      if (decision.kind === "message") {
        if (publicCommentary && publicCommentary !== decision.text) persistDurableEvent({ type: "model.commentary", text: publicCommentary });
        checkpoint.messages.push({ role: "assistant", content: decision.text, ...(decision.reasoning ? { reasoning: decision.reasoning } : {}) });
        const messageEvent = emit({ type: "assistant.message", text: decision.text }, false) as AssistantMessageEvent;
        if (decision.finish !== false) {
          checkpoint.status = "completed";
          checkpoint.finalText = decision.text;
          const completedEvent = emit({ type: "turn.completed", text: decision.text }, false);
          await this.store.saveWithAssistantMessage(runId, checkpoint, { messageKey: `assistant:${messageEvent.eventId}`, text: messageEvent.text });
          await flushDurableEvents();
          onEvent?.(messageEvent); onEvent?.(completedEvent);
          return { checkpoint, events };
        }
        await persistAssistantMessage(messageEvent);
        continue;
      }
      if (decision.kind === "ask_user") {
        if (publicCommentary && publicCommentary !== decision.text) persistDurableEvent({ type: "model.commentary", text: publicCommentary });
        checkpoint.status = "awaiting_user";
        checkpoint.pendingInteraction = { interactionId: crypto.randomUUID(), type: "user_input", question: decision.text };
        checkpoint.messages.push({ role: "assistant", content: decision.text, ...(decision.reasoning ? { reasoning: decision.reasoning } : {}) });
        const messageEvent = emit({ type: "assistant.message", text: decision.text }, false) as AssistantMessageEvent;
        await persistAssistantMessage(messageEvent);
        return { checkpoint, events };
      }
      if (publicCommentary) persistDurableEvent({ type: "model.commentary", text: publicCommentary });
      for (const [index, call] of decision.calls.entries()) {
        checkpoint.toolCallCount += 1;
        if (checkpoint.toolCallCount > this.maxToolCalls) {
          checkpoint.status = "failed";
          checkpoint.finalText = "Agent stopped after reaching its tool-call safety budget.";
          const failureMessage = emit({ type: "assistant.message", text: checkpoint.finalText }, false) as AssistantMessageEvent;
          const failureEvent = emit({ type: "turn.failed", error: checkpoint.finalText }, false);
          await this.store.saveWithAssistantMessage(runId, checkpoint, { messageKey: `assistant:${failureMessage.eventId}`, text: failureMessage.text });
          await flushDurableEvents();
          onEvent?.(failureMessage); onEvent?.(failureEvent);
          return { checkpoint, events };
        }
        // Keep each assistant tool-call message paired with the result that
        // follows it. If a later call needs approval, calls after that
        // boundary are intentionally left for the next model decision rather
        // than persisting unpaired tool-call IDs into the transcript.
        checkpoint.messages.push({
          role: "assistant",
          content: index === 0 ? (decision.text ?? "") : "",
          toolCalls: [call],
          ...(decision.reasoning ? { reasoning: decision.reasoning } : {}),
        });
        const tool = this.tools.find((candidate) => candidate.name === call.name);
        if (!tool) {
          checkpoint.messages.push({ role: "tool", content: JSON.stringify({ error: `Unknown agent tool: ${call.name}` }), toolCallId: call.id, toolName: call.name });
          emit({ type: "tool.failed", callId: call.id, name: call.name, error: `Unknown agent tool: ${call.name}` });
          await saveCheckpoint();
          continue;
        }
        let input: unknown;
        try {
          input = tool.inputSchema.parse(call.input);
        } catch (error) {
          const validation = formatToolInputValidationError(error);
          const message = validation ? JSON.stringify(validation) : error instanceof Error ? error.message : "Tool input validation failed";
          checkpoint.messages.push({ role: "tool", content: message, toolCallId: call.id, toolName: call.name });
          emit({ type: "tool.failed", callId: call.id, name: call.name, error: validation ? JSON.stringify(validation) : message });
          await saveCheckpoint();
          continue;
        }
        if (tool.requiresApproval && checkpoint.permissionMode !== "full") {
          const interactionId = crypto.randomUUID();
          checkpoint.pendingInteraction = { interactionId, type: "approval", callId: call.id, toolName: call.name, input };
          checkpoint.status = "awaiting_approval";
          const approvalEvent = emit({ type: "approval.required", interactionId, callId: call.id, name: call.name, input }, false);
          await saveCheckpoint();
          onEvent?.(approvalEvent);
          return { checkpoint, events };
        }
        if (tool.clientExecution) {
          const interactionId = crypto.randomUUID();
          const clientInput = call.input as { target?: unknown; pageNumber?: unknown };
          checkpoint.pendingInteraction = {
            interactionId,
            type: "client_tool",
            callId: call.id,
            toolName: call.name,
            input,
          };
          checkpoint.status = "awaiting_client";
          const requiredEvent = emit({
            type: "client_tool.required",
            interactionId,
            callId: call.id,
            name: call.name,
            target: clientInput.target === "page" ? "page" : "visible",
            ...(typeof clientInput.pageNumber === "number" ? { pageNumber: clientInput.pageNumber } : {}),
          }, false);
          await saveCheckpoint();
          onEvent?.(requiredEvent);
          return { checkpoint, events };
        }
        const idempotencyKey = `${runId}:${call.id}`;
        const existingReceipt = await this.store.loadEffectReceipt?.(runId, idempotencyKey);
        if (existingReceipt) {
          checkpoint.messages.push({ role: "tool", content: serializeToolOutput(existingReceipt.output), toolCallId: call.id, toolName: call.name });
          const replayedEvent = emit({ type: "tool.completed", callId: call.id, name: call.name, output: projectToolOutputForEvent(call.name, existingReceipt.output) }, false);
          await saveCheckpoint();
          onEvent?.(replayedEvent);
          continue;
        }
        const toolStartedEvent = emit({ type: "tool.started", callId: call.id, name: call.name, input }, false);
        // Make the side-effect boundary durable before executing the tool.
        // This is what lets recovery distinguish an in-flight operation from
        // a run that has not reached the tool yet.
        await saveCheckpoint();
        onEvent?.(toolStartedEvent);
        const toolStartedAt = Date.now();
        try {
          const output = await this.withLeaseHeartbeat(runId, () => tool.execute(input, { runId, callId: call.id, idempotencyKey, attempt: checkpoint.toolCallCount, signal }));
          const receipt = this.store.saveEffectReceipt
            ? await this.store.saveEffectReceipt(runId, { idempotencyKey, callId: call.id, toolName: call.name, output, completedAt: new Date().toISOString() })
            : { idempotencyKey, callId: call.id, toolName: call.name, output, completedAt: new Date().toISOString() };
          checkpoint.messages.push({ role: "tool", content: serializeToolOutput(receipt.output), toolCallId: call.id, toolName: call.name });
          const toolCompletedEvent = emit({ type: "tool.completed", callId: call.id, name: call.name, output: projectToolOutputForEvent(call.name, { ...((receipt.output && typeof receipt.output === "object") ? receipt.output : { value: receipt.output }), durationMs: Date.now() - toolStartedAt }) }, false);
          await saveCheckpoint();
          onEvent?.(toolCompletedEvent);
        } catch (error) {
          if (signal?.aborted) {
            const latest = await this.store.load(runId);
            if (latest?.status === "cancelled") return { checkpoint: latest, events };
            await this.store.releaseLeaseForRecovery?.(runId);
            throw new Error(TRANSPORT_INTERRUPTED);
          }
          const reconciledReceipt = await this.reconcileEffectReceiptAfterToolError(runId, idempotencyKey);
          if (reconciledReceipt) {
            checkpoint.messages.push({ role: "tool", content: serializeToolOutput(reconciledReceipt.output), toolCallId: call.id, toolName: call.name });
            const completedEvent = emit({ type: "tool.completed", callId: call.id, name: call.name, output: projectToolOutputForEvent(call.name, { ...((reconciledReceipt.output && typeof reconciledReceipt.output === "object") ? reconciledReceipt.output : { value: reconciledReceipt.output }), durationMs: Date.now() - toolStartedAt }) }, false);
            await saveCheckpoint();
            onEvent?.(completedEvent);
          } else {
            const message = error instanceof Error ? error.message : "Tool execution failed";
            checkpoint.messages.push({ role: "tool", content: JSON.stringify({ error: message }), toolCallId: call.id, toolName: call.name });
            const toolFailedEvent = emit({ type: "tool.failed", callId: call.id, name: call.name, error: message, durationMs: Date.now() - toolStartedAt }, false);
            await saveCheckpoint();
            onEvent?.(toolFailedEvent);
          }
        }
      }
      // A successful or failed tool execution already persisted the
      // checkpoint at its side-effect boundary. Avoid an unconditional second
      // read/update round-trip, which is noticeable with remote stores such as
      // Supabase. Empty tool batches still need a save so the model boundary
      // and all structural activity is flushed before the next model boundary.
      if (decision.calls.length === 0) await saveCheckpoint();
    }
    checkpoint.status = "failed";
    checkpoint.finalText = "本轮操作未能在安全步数内完成。已保留已完成的读取结果，未提交未确认的写入；请缩小范围后重试。";
    const terminalMessage = emit({ type: "assistant.message", text: checkpoint.finalText }, false) as AssistantMessageEvent;
    const terminalFailure = emit({ type: "turn.failed", error: checkpoint.finalText }, false);
    await this.store.saveWithAssistantMessage(runId, checkpoint, { messageKey: `assistant:${terminalMessage.eventId}`, text: terminalMessage.text });
    await flushDurableEvents();
    onEvent?.(terminalMessage); onEvent?.(terminalFailure);
    return { checkpoint, events };
  }

  async resume(runId: string, approval: "approved" | "rejected", interactionId: string, callId: string, signal?: AbortSignal, onEvent?: (event: AgentEvent) => void): Promise<AgentLoopResult> {
    const current = await this.store.load(runId);
    if (current?.status === "cancelled") throw new Error("RUN_CANCELLED");
    const pending = current?.pendingInteraction?.type === "approval" ? current.pendingInteraction : undefined;
    const existingResolution = current?.pendingResolution?.type === "approval" ? current.pendingResolution : undefined;
    if (!pending && !existingResolution) throw new Error("No pending agent approval");
    const resolvedDecision = existingResolution?.decision;
    if (existingResolution && (existingResolution.interactionId !== interactionId || existingResolution.callId !== callId)) throw new Error("APPROVAL_INTERACTION_MISMATCH");
    if (resolvedDecision && resolvedDecision !== approval) throw new Error("APPROVAL_RESOLUTION_MISMATCH");
    if (pending && (pending.interactionId !== interactionId || pending.callId !== callId)) throw new Error("APPROVAL_INTERACTION_MISMATCH");
    const checkpoint = existingResolution
      ? current!
      : this.store.resolvePendingApproval
        ? await this.store.resolvePendingApproval(runId, interactionId, callId, approval)
        : current
          ? { ...current, status: "running" as const, pendingInteraction: undefined, pendingResolution: { interactionId, type: "approval" as const, callId, toolName: pending!.toolName, input: pending!.input, decision: approval } }
          : undefined;
    if (!checkpoint) throw new Error("APPROVAL_ALREADY_CLAIMED");
    const resolved = checkpoint.pendingResolution?.type === "approval" ? checkpoint.pendingResolution : undefined;
    if (!resolved) throw new Error("APPROVAL_RESOLUTION_MISSING");
    const toolName = resolved.toolName;
    const inputValue = resolved.input;
    checkpoint.pendingInteraction = undefined;
    checkpoint.status = "running";
    const tool = this.tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Unknown agent tool: ${toolName}`);
    const input = tool.inputSchema.parse(inputValue);
    const events: AgentEvent[] = [];
    const durableEvents: AgentEvent[] = [];
    let eventPersistenceChain = Promise.resolve();
    const flushDurableEvents = () => {
      if (!durableEvents.length || !this.store.appendEvents) return eventPersistenceChain;
      const batch = durableEvents.splice(0, durableEvents.length);
      eventPersistenceChain = eventPersistenceChain.then(async () => {
        try {
          await this.store.appendEvents!(runId, batch);
        } catch {
          for (const event of batch) {
            this.onEngineeringEvent?.({ event: "agent.event.persist_failed", metadata: { runId, eventId: event.eventId, eventType: event.type } });
          }
        }
      });
      return eventPersistenceChain;
    };
    const saveCheckpoint = async () => {
      await this.store.save(runId, checkpoint);
      void flushDurableEvents();
    };
    const emit = (event: AgentEventPayload, notify = true) => {
      const activityEvent = createAgentEvent(runId, event);
      events.push(activityEvent);
      this.observe(runId, activityEvent, checkpoint.permissionMode);
      if (shouldPersistAgentEvent(activityEvent)) durableEvents.push(activityEvent);
      if (notify) onEvent?.(activityEvent);
      return activityEvent;
    };
    if (!existingResolution) {
      const approvalEvent = emit({ type: "approval.resolved", interactionId: resolved.interactionId, callId: resolved.callId, name: resolved.toolName, decision: resolved.decision }, false);
      await saveCheckpoint();
      onEvent?.(approvalEvent);
    }
    if (resolved.decision === "approved") {
      const idempotencyKey = `${runId}:${resolved.callId}`;
      const existingReceipt = await this.store.loadEffectReceipt?.(runId, idempotencyKey);
      if (existingReceipt) {
        checkpoint.messages.push({ role: "tool", content: serializeToolOutput({ approval: resolved.decision, output: existingReceipt.output }), toolCallId: resolved.callId, toolName: resolved.toolName });
        const replayedEvent = emit({ type: "tool.completed", callId: resolved.callId, name: resolved.toolName, output: projectToolOutputForEvent(resolved.toolName, existingReceipt.output) }, false);
        checkpoint.pendingResolution = undefined;
        await saveCheckpoint();
        onEvent?.(replayedEvent);
      } else {
      const startedEvent = emit({ type: "tool.started", callId: resolved.callId, name: resolved.toolName, input: summarizeTraceValue(input) }, false);
      // Persist the approval claim and the operation start before side effects.
      // If the request is interrupted, the checkpoint and effect receipt
      // remain the recovery source; activity is persisted independently.
      await saveCheckpoint();
      onEvent?.(startedEvent);
      const toolStartedAt = Date.now();
      try {
        const output = await this.withLeaseHeartbeat(runId, () => tool.execute(input, { runId, callId: resolved.callId, idempotencyKey, attempt: checkpoint.toolCallCount, signal }));
        const receipt = this.store.saveEffectReceipt
          ? await this.store.saveEffectReceipt(runId, { idempotencyKey, callId: resolved.callId, toolName: resolved.toolName, output, completedAt: new Date().toISOString() })
          : { idempotencyKey, callId: resolved.callId, toolName: resolved.toolName, output, completedAt: new Date().toISOString() };
        checkpoint.messages.push({ role: "tool", content: serializeToolOutput({ approval: resolved.decision, output: receipt.output }), toolCallId: resolved.callId, toolName: resolved.toolName });
        const completedEvent = emit({ type: "tool.completed", callId: resolved.callId, name: resolved.toolName, output: projectToolOutputForEvent(resolved.toolName, { ...((receipt.output && typeof receipt.output === "object") ? receipt.output : { value: receipt.output }), durationMs: Date.now() - toolStartedAt }) }, false);
        checkpoint.pendingResolution = undefined;
        await saveCheckpoint();
        onEvent?.(completedEvent);
      } catch (error) {
        if (signal?.aborted) {
          const latest = await this.store.load(runId);
          if (latest?.status === "cancelled") return { checkpoint: latest, events };
          await this.store.releaseLeaseForRecovery?.(runId);
          throw new Error(TRANSPORT_INTERRUPTED);
        }
        const reconciledReceipt = await this.reconcileEffectReceiptAfterToolError(runId, idempotencyKey);
        if (reconciledReceipt) {
          checkpoint.messages.push({ role: "tool", content: serializeToolOutput({ approval: resolved.decision, output: reconciledReceipt.output }), toolCallId: resolved.callId, toolName: resolved.toolName });
          const completedEvent = emit({ type: "tool.completed", callId: resolved.callId, name: resolved.toolName, output: projectToolOutputForEvent(resolved.toolName, { ...((reconciledReceipt.output && typeof reconciledReceipt.output === "object") ? reconciledReceipt.output : { value: reconciledReceipt.output }), durationMs: Date.now() - toolStartedAt }) }, false);
          checkpoint.pendingResolution = undefined;
          await saveCheckpoint();
          onEvent?.(completedEvent);
        } else {
          const message = error instanceof Error ? error.message : "Tool execution failed";
          checkpoint.messages.push({ role: "tool", content: JSON.stringify({ approval: resolved.decision, error: message }), toolCallId: resolved.callId, toolName: resolved.toolName });
          const failedEvent = emit({ type: "tool.failed", callId: resolved.callId, name: resolved.toolName, error: message, durationMs: Date.now() - toolStartedAt }, false);
          checkpoint.pendingResolution = undefined;
          await saveCheckpoint();
          onEvent?.(failedEvent);
        }
      }
      }
    } else {
      checkpoint.messages.push({ role: "tool", content: JSON.stringify({ approval: "rejected", reason: "The user rejected this action." }), toolCallId: resolved.callId, toolName: resolved.toolName });
      const rejectedEvent = emit({ type: "tool.failed", callId: resolved.callId, name: resolved.toolName, error: "User rejected the tool call." }, false);
      checkpoint.pendingResolution = undefined;
      await saveCheckpoint();
      onEvent?.(rejectedEvent);
    }
    const continuation = await this.runWithPermission(runId, "", checkpoint.permissionMode ?? "default", signal, onEvent);
    return { checkpoint: continuation.checkpoint, events: [...events, ...continuation.events] };
  }

  async resumeClientTool(runId: string, interactionId: string, callId: string, result: AgentClientToolResult, signal?: AbortSignal, onEvent?: (event: AgentEvent) => void): Promise<AgentLoopResult> {
    const current = await this.store.load(runId);
    if (current?.status === "cancelled") throw new Error("RUN_CANCELLED");
    const pending = current?.pendingInteraction?.type === "client_tool" ? current.pendingInteraction : undefined;
    const existingResolution = current?.pendingResolution?.type === "client_tool" ? current.pendingResolution : undefined;
    if (!pending && !existingResolution) throw new Error("No pending client tool");
    const resolved = existingResolution ?? {
      interactionId,
      type: "client_tool" as const,
      callId,
      toolName: pending!.toolName,
      result,
    };
    if (resolved.interactionId !== interactionId || resolved.callId !== callId) throw new Error("CLIENT_TOOL_INTERACTION_MISMATCH");
    const checkpoint = existingResolution
      ? current!
      : this.store.resolvePendingClientTool
        ? await this.store.resolvePendingClientTool(runId, interactionId, callId, result)
        : undefined;
    if (!checkpoint) throw new Error("CLIENT_TOOL_ALREADY_CLAIMED");
    const actual = checkpoint.pendingResolution?.type === "client_tool" ? checkpoint.pendingResolution : resolved;
    checkpoint.pendingInteraction = undefined;
    checkpoint.status = "running";
    checkpoint.messages.push({ role: "tool", content: serializeToolOutput(actual.result), toolCallId: actual.callId, toolName: actual.toolName });
    const events: AgentEvent[] = [];
    const required = existingResolution ? undefined : createAgentEvent(runId, { type: "client_tool.resolved", interactionId: actual.interactionId, callId: actual.callId, name: actual.toolName, ...actual.result });
    if (required) { events.push(required); this.observe(runId, required, checkpoint.permissionMode); onEvent?.(required); }
    checkpoint.pendingResolution = undefined;
    await this.store.save(runId, checkpoint);
    const continuation = await this.runWithPermission(runId, "", checkpoint.permissionMode ?? "default", signal, onEvent);
    return { checkpoint: continuation.checkpoint, events: [...events, ...continuation.events] };
  }
}
