import type { BrowserAgentLoopResult, BrowserConversationMessage } from "@/modules/agent/browser-runtime";
import { reduceAgentEvents, type AgentActivity } from "./agent-turn-reducer";
export type { AgentActivity } from "./agent-turn-reducer";

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
  const reduced = reduceAgentEvents(events, runId);
  const activities = reduced.activities;
  const streamingContent = reduced.streamingContent || reduced.textBuffer;
  if (!userText && !finalContent && !events.length) return undefined;
  return { id: runId, runId, user: { id: user?.id ?? `${runId}:user`, content: userText ?? events.find((event) => event.type === "turn.started")?.text ?? "", createdAt: user?.created_at, deliveryStatus: user?.delivery_status ?? "sent" }, assistant: { messageId: assistant?.id, status: assistantStatus(events, finalContent), streamingContent: streamingContent || undefined, finalContent, activities } };
}

export function projectAgentThread(input: { messages: readonly BrowserConversationMessage[]; historicalEvents: readonly AgentEvent[]; activeEvents: readonly AgentEvent[]; activeRunId?: string }): AgentThreadProjection {
  const messagesByRun = new Map<string, BrowserConversationMessage[]>();
  for (const message of input.messages) {
    const runId = message.turn_id ?? message.run_id ?? input.activeRunId;
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
