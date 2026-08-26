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
};

export type AgentLoopStore = {
  load(runId: string): Promise<AgentLoopCheckpoint | undefined>;
  save(runId: string, checkpoint: AgentLoopCheckpoint): Promise<void>;
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

export class AgentLoopRunner {
  constructor(
    private readonly model: AgentModelPort,
    private readonly store: AgentLoopStore,
    private readonly tools: readonly AgentTool[],
    private readonly maxIterations = 12,
    private readonly maxToolCalls = 32,
  ) {}

  async run(runId: string, userText: string, signal?: AbortSignal): Promise<AgentLoopResult> {
    const current = await this.store.load(runId);
    const checkpoint: AgentLoopCheckpoint = current ?? {
      messages: [],
      iterations: 0,
      toolCallCount: 0,
      status: "running",
    };
    if (checkpoint.status === "completed" || checkpoint.status === "failed") {
      return { checkpoint, events: checkpoint.finalText ? [{ type: "completed", text: checkpoint.finalText }] : [] };
    }
    if (userText.trim()) checkpoint.messages.push({ role: "user", content: userText });
    checkpoint.status = "running";
    const events: AgentLoopEvent[] = [];

    while (checkpoint.iterations < this.maxIterations) {
      checkpoint.iterations += 1;
      const decision = await this.model.decide({ messages: checkpoint.messages, tools: this.tools, signal });
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
        if (tool.requiresApproval) {
          checkpoint.pendingApproval = { callId: call.id, name: call.name, input };
          checkpoint.status = "awaiting_user";
          events.push({ type: "approval.required", callId: call.id, name: call.name, input });
          await this.store.save(runId, checkpoint);
          return { checkpoint, events };
        }
        events.push({ type: "tool.started", callId: call.id, name: call.name, input });
        try {
          const output = await tool.execute(input, { runId, signal });
          checkpoint.messages.push({ role: "tool", content: JSON.stringify(output), toolCallId: call.id, toolName: call.name });
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
    const checkpoint = await this.store.load(runId);
    if (!checkpoint?.pendingApproval) throw new Error("No pending agent approval");
    const pending = checkpoint.pendingApproval;
    checkpoint.pendingApproval = undefined;
    checkpoint.status = "running";
    const tool = this.tools.find((candidate) => candidate.name === pending.name);
    if (!tool) throw new Error(`Unknown agent tool: ${pending.name}`);
    const input = tool.inputSchema.parse(pending.input);
    if (approval === "approved") {
      try {
        const output = await tool.execute(input, { runId, signal });
        checkpoint.messages.push({ role: "tool", content: JSON.stringify({ approval, output }), toolCallId: pending.callId, toolName: pending.name });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool execution failed";
        checkpoint.messages.push({ role: "tool", content: JSON.stringify({ approval, error: message }), toolCallId: pending.callId, toolName: pending.name });
      }
    } else {
      checkpoint.messages.push({ role: "tool", content: JSON.stringify({ approval: "rejected", reason: "The user rejected this action." }), toolCallId: pending.callId, toolName: pending.name });
    }
    await this.store.save(runId, checkpoint);
    return this.run(runId, "", signal);
  }
}
