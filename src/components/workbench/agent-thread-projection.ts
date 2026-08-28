import type { AgentEvent } from "@/modules/agent/application/events";
import type { BrowserConversationMessage } from "@/modules/agent/browser-runtime";
import { reduceAgentEvents, type AgentActivity } from "./agent-turn-reducer";
export type { AgentActivity } from "./agent-turn-reducer";

export type AgentThreadAssistant = {
  messageId?: string;
  status: "running" | "awaiting_approval" | "awaiting_user" | "completed" | "failed" | "cancelled";
  streamingContent?: string;
  finalContent?: string;
  activities: readonly AgentActivity[];
};
export type AgentThreadTurn = {
  id: string; runId?: string; anchor: string;
  user?: { id: string; content: string; createdAt?: string; deliveryStatus: "pending" | "sent" | "failed" };
  assistant: AgentThreadAssistant;
};
export type AgentThreadProjection = { turns: readonly AgentThreadTurn[] };

const textPart = (message: BrowserConversationMessage) => message.parts.find((part) => part.type === "text")?.text;
const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? value : "";
const eventTimestamp = (events: readonly AgentEvent[]) => events.map((event) => event.timestamp).filter(Boolean).sort()[0] ?? "";
const emptyAssistant = (pending: boolean): AgentThreadAssistant => ({ status: pending ? "running" : "completed", activities: [] });
function assistantStatus(events: readonly AgentEvent[], finalContent?: string): AgentThreadAssistant["status"] {
  if (events.some((event) => event.type === "approval.required")) return "awaiting_approval";
  if (events.some((event) => event.type === "turn.cancelled")) return "cancelled";
  if (events.some((event) => event.type === "turn.failed")) return "failed";
  if (events.some((event) => event.type === "turn.completed" || event.type === "assistant.message") || finalContent) return "completed";
  return events.length ? "running" : "completed";
}
function assistantFor(runId: string, events: readonly AgentEvent[], message?: BrowserConversationMessage): AgentThreadAssistant {
  const finalContent = message && textPart(message);
  const reduced = reduceAgentEvents(events, runId);
  const streamingContent = reduced.streamingContent || reduced.textBuffer;
  return { messageId: message?.id, status: assistantStatus(events, finalContent), streamingContent: streamingContent || undefined, finalContent: finalContent || undefined, activities: reduced.activities };
}
function compareAnchors(a: AgentThreadTurn, b: AgentThreadTurn) {
  const at = Date.parse(a.anchor); const bt = Date.parse(b.anchor);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
  if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1;
  return a.id.localeCompare(b.id);
}

export function projectAgentThread(input: { messages: readonly BrowserConversationMessage[]; historicalEvents: readonly AgentEvent[]; activeEvents: readonly AgentEvent[]; activeRunId?: string }): AgentThreadProjection {
  const messagesByRun = new Map<string, Array<{ message: BrowserConversationMessage; index: number }>>();
  const turns: AgentThreadTurn[] = [];
  input.messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    const runId = message.run_id ?? undefined;
    if (!runId) {
      turns.push(message.role === "user"
        ? { id: message.id, user: { id: message.id, content: textPart(message) ?? "", createdAt: message.created_at, deliveryStatus: message.delivery_status ?? "sent" }, assistant: emptyAssistant(message.delivery_status === "pending"), anchor: timestamp(message.created_at) }
        : { id: message.id, assistant: assistantFor(`message:${message.id}`, [], message), anchor: timestamp(message.created_at) });
      return;
    }
    const list = messagesByRun.get(runId) ?? []; list.push({ message, index }); messagesByRun.set(runId, list);
  });
  const eventsByRun = new Map<string, AgentEvent[]>();
  for (const event of [...input.historicalEvents, ...input.activeEvents]) {
    const list = eventsByRun.get(event.runId) ?? [];
    if (!list.some((candidate) => candidate.eventId === event.eventId)) list.push(event);
    eventsByRun.set(event.runId, list);
  }
  for (const [runId, indexedMessages] of messagesByRun) {
    const messages = [...indexedMessages].sort((a, b) => timestamp(a.message.created_at).localeCompare(timestamp(b.message.created_at)) || a.index - b.index).map(({ message }) => message);
    const events = eventsByRun.get(runId) ?? [];
    const lastAssistantIndex = messages.map((message, index) => message.role === "assistant" ? index : -1).filter((index) => index >= 0).at(-1);
    let previousUser: AgentThreadTurn | undefined;
    for (const [index, message] of messages.entries()) {
      if (message.role === "user") {
        const userTurn: AgentThreadTurn = { id: message.id, runId, user: { id: message.id, content: textPart(message) ?? "", createdAt: message.created_at, deliveryStatus: message.delivery_status ?? "sent" }, assistant: emptyAssistant(message.delivery_status === "pending"), anchor: timestamp(message.created_at) };
        previousUser = userTurn; turns.push(userTurn);
      } else {
        const assistant = assistantFor(runId, index === lastAssistantIndex ? events : [], message);
        if (previousUser && !previousUser.assistant.messageId && !previousUser.assistant.finalContent && !previousUser.assistant.streamingContent && previousUser.assistant.activities.length === 0) { previousUser.assistant = assistant; previousUser = undefined; }
        else turns.push({ id: message.id, runId, assistant, anchor: timestamp(message.created_at) || eventTimestamp(events) });
      }
    }
    if (events.length && lastAssistantIndex === undefined) {
      const user = [...turns].reverse().find((turn) => turn.runId === runId && turn.user && !turn.assistant.messageId && !turn.assistant.finalContent && !turn.assistant.streamingContent && turn.assistant.activities.length === 0); const assistant = assistantFor(runId, events);
      if (user) user.assistant = assistant;
      else { const started = events.find((event) => event.type === "turn.started"); turns.push({ id: `${runId}:assistant`, runId, assistant, anchor: started?.timestamp ?? eventTimestamp(events) }); }
    }
    if (!messages.length && events.length) { const started = events.find((event) => event.type === "turn.started"); turns.push({ id: `${runId}:user`, runId, user: { id: `${runId}:user`, content: started?.text ?? "", createdAt: started?.timestamp, deliveryStatus: "sent" }, assistant: assistantFor(runId, events), anchor: started?.timestamp ?? eventTimestamp(events) }); }
  }
  for (const [runId, events] of eventsByRun) {
    if (messagesByRun.has(runId)) continue;
    const started = events.find((event) => event.type === "turn.started");
    turns.push({ id: `${runId}:user`, runId, user: { id: `${runId}:user`, content: started?.text ?? "", createdAt: started?.timestamp, deliveryStatus: "sent" }, assistant: assistantFor(runId, events), anchor: started?.timestamp ?? eventTimestamp(events) });
  }
  return { turns: turns.filter((turn) => turn.user || turn.assistant).sort(compareAnchors) };
}
