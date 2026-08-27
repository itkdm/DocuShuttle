import type { BrowserAgentLoopResult, BrowserConversationMessage } from "@/modules/agent/browser-runtime";

export type AgentActivity =
  | { type: "note"; id: string; text: string }
  | { type: "tool"; id: string; callId: string; name: string; state: "running" | "completed" | "failed" | "approval"; input?: unknown; output?: unknown; error?: string; durationMs?: number };

export type AgentThreadTurn = {
  id: string;
  runId: string;
  user: { id: string; content: string; createdAt?: string; deliveryStatus: "pending" | "sent" | "failed" };
  assistant: { messageId?: string; status: "running" | "awaiting_approval" | "awaiting_user" | "completed" | "failed" | "cancelled"; streamingContent?: string; finalContent?: string; activities: readonly AgentActivity[] };
};

export type AgentThreadProjection = { turns: readonly AgentThreadTurn[] };
type AgentEvent = BrowserAgentLoopResult["events"][number];
const textPart = (message: BrowserConversationMessage) => message.parts.find((part) => part.type === "text")?.text;

function assistantStatus(events: readonly AgentEvent[], finalContent?: string): AgentThreadTurn["assistant"]["status"] {
  if (events.some((event) => event.type === "approval.required")) return "awaiting_approval";
  if (events.some((event) => event.type === "turn.cancelled")) return "cancelled";
  if (events.some((event) => event.type === "turn.failed")) return "failed";
  if (events.some((event) => event.type === "completed" || event.type === "assistant.message") || finalContent) return "completed";
  return events.length ? "running" : "completed";
}

function projectRun(runId: string, messages: readonly BrowserConversationMessage[], events: readonly AgentEvent[]): AgentThreadTurn | undefined {
  const user = messages.find((message) => message.role === "user");
  const assistant = messages.findLast((message) => message.role === "assistant");
  const userText = user && textPart(user);
  const finalContent = assistant && textPart(assistant);
  const activities: AgentActivity[] = [];
  let streamingContent = "";
  let note = "";
  const tools = new Map<string, Extract<AgentActivity, { type: "tool" }>>();
  const flushNote = () => { if (note) { activities.push({ type: "note", id: `${runId}:note:${activities.length}`, text: note }); note = ""; } };
  for (const event of events) {
    if (event.type === "model.delta") streamingContent += event.text ?? "";
    else if (event.type === "tool.started" || event.type === "approval.required") {
      flushNote();
      const callId = String((event as { callId?: unknown }).callId ?? "unknown");
      const tool: Extract<AgentActivity, { type: "tool" }> = { type: "tool", id: event.eventId ?? `${runId}:tool:${callId}`, callId, name: event.name ?? "document_operation", state: event.type === "approval.required" ? "approval" : "running", input: event.input };
      tools.set(callId, tool); activities.push(tool);
    } else if (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "approval.resolved") {
      const tool = tools.get(String((event as { callId?: unknown }).callId ?? "unknown"));
      if (!tool) continue;
      if (event.type === "tool.completed") Object.assign(tool, { state: "completed" as const, output: event.output, durationMs: typeof event.output === "object" && event.output && "durationMs" in event.output ? Number(event.output.durationMs) : undefined });
      if (event.type === "tool.failed") Object.assign(tool, { state: "failed" as const, error: event.error, durationMs: event.durationMs });
      if (event.type === "approval.resolved") Object.assign(tool, { state: event.decision === "approved" ? "running" as const : "failed" as const, error: event.decision === "rejected" ? "已拒绝" : undefined });
    } else if (event.type === "model.completed") flushNote();
  }
  flushNote();
  if (!userText && !finalContent && !events.length) return undefined;
  return { id: runId, runId, user: { id: user?.id ?? `${runId}:user`, content: userText ?? events.find((event) => event.type === "turn.started")?.text ?? "", createdAt: user?.created_at, deliveryStatus: user?.delivery_status ?? "sent" }, assistant: { messageId: assistant?.id, status: assistantStatus(events, finalContent), streamingContent: streamingContent || undefined, finalContent, activities } };
}

export function projectAgentThread(input: { messages: readonly BrowserConversationMessage[]; historicalEvents: readonly AgentEvent[]; activeEvents: readonly AgentEvent[]; activeRunId?: string }): AgentThreadProjection {
  const messagesByRun = new Map<string, BrowserConversationMessage[]>();
  for (const message of input.messages) {
    const runId = message.run_id ?? input.activeRunId;
    if (!runId) continue;
    const list = messagesByRun.get(runId) ?? []; list.push(message); messagesByRun.set(runId, list);
  }
  const eventsByRun = new Map<string, AgentEvent[]>();
  for (const event of [...input.historicalEvents, ...input.activeEvents]) {
    const runId = event.runId ?? input.activeRunId;
    if (!runId) continue;
    const list = eventsByRun.get(runId) ?? [];
    if (!event.eventId || !list.some((candidate) => candidate.eventId === event.eventId)) list.push(event);
    eventsByRun.set(runId, list);
  }
  const runIds = [...new Set([...messagesByRun.keys(), ...eventsByRun.keys()])];
  return { turns: runIds.flatMap((runId) => { const turn = projectRun(runId, messagesByRun.get(runId) ?? [], eventsByRun.get(runId) ?? []); return turn ? [turn] : []; }) };
}
