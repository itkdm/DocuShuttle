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
const parsedTime = (value?: string) => value ? Date.parse(value) : Number.NaN;
const validTime = (value?: string) => Number.isFinite(parsedTime(value)) ? value! : "";
const eventTime = (event: AgentEvent) => parsedTime(event.timestamp);
const earliestEventTime = (events: readonly AgentEvent[]) => [...events].sort((a, b) => eventTime(a) - eventTime(b))[0]?.timestamp ?? "";
const emptyAssistant = (pending = false): AgentThreadAssistant => ({ status: pending ? "running" : "completed", activities: [] });

function assistantStatus(events: readonly AgentEvent[], finalContent?: string): AgentThreadAssistant["status"] {
  const ordered = [...events].sort((a, b) => eventTime(a) - eventTime(b));
  if (ordered.some((event) => event.type === "turn.cancelled")) return "cancelled";
  if (ordered.some((event) => event.type === "turn.failed")) return "failed";
  const approvalRequired = ordered.findLast((event) => event.type === "approval.required");
  if (approvalRequired) {
    const resolved = ordered.findLast((event) => event.type === "approval.resolved" && event.interactionId === approvalRequired.interactionId) as Extract<AgentEvent, { type: "approval.resolved" }> | undefined;
    if (!resolved) return "awaiting_approval";
  }
  if (ordered.some((event) => event.type === "turn.completed" || event.type === "assistant.message" || event.type === "tool.completed") || finalContent) return "completed";
  return events.length ? "running" : "completed";
}

function assistantFor(runId: string, events: readonly AgentEvent[], message?: BrowserConversationMessage): AgentThreadAssistant {
  const finalContent = message && textPart(message);
  const reduced = reduceAgentEvents(events, runId);
  const streamingContent = reduced.streamingContent || reduced.textBuffer;
  return { messageId: message?.id, status: assistantStatus(events, finalContent), streamingContent: finalContent ? undefined : streamingContent || undefined, finalContent: finalContent || undefined, activities: reduced.activities };
}

function compareAnchors(a: AgentThreadTurn, b: AgentThreadTurn) {
  const at = parsedTime(a.anchor); const bt = parsedTime(b.anchor);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
  if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function eventsForPhase(events: readonly AgentEvent[], start: string, end?: string) {
  const startTime = parsedTime(start); const endTime = parsedTime(end);
  return events.filter((event) => {
    const time = eventTime(event);
    if (!Number.isFinite(time)) return !Number.isFinite(endTime);
    if (Number.isFinite(startTime) && time < startTime) return false;
    return !Number.isFinite(endTime) || time < endTime;
  }).sort((a, b) => eventTime(a) - eventTime(b));
}

export function projectAgentThread(input: { messages: readonly BrowserConversationMessage[]; historicalEvents: readonly AgentEvent[]; activeEvents: readonly AgentEvent[]; activeRunId?: string }): AgentThreadProjection {
  const messagesByRun = new Map<string, Array<{ message: BrowserConversationMessage; index: number }>>();
  const turns: AgentThreadTurn[] = [];
  input.messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    const runId = message.run_id ?? undefined;
    if (!runId) {
      turns.push(message.role === "user"
        ? { id: message.id, user: { id: message.id, content: textPart(message) ?? "", createdAt: message.created_at, deliveryStatus: message.delivery_status ?? "sent" }, assistant: emptyAssistant(message.delivery_status === "pending"), anchor: validTime(message.created_at) }
        : { id: message.id, assistant: assistantFor(`message:${message.id}`, [], message), anchor: validTime(message.created_at) });
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
    const messages = [...indexedMessages].sort((a, b) => parsedTime(a.message.created_at) - parsedTime(b.message.created_at) || a.index - b.index).map(({ message }) => message);
    const events = eventsByRun.get(runId) ?? [];
    const users = messages.filter((message) => message.role === "user");
    const phaseTurns = users.map((message, index) => {
      const nextUser = users[index + 1];
      const phaseEvents = eventsForPhase(events, message.created_at, nextUser?.created_at);
      const assistantMessage = messages.find((candidate) => candidate.role === "assistant" && parsedTime(candidate.created_at) >= parsedTime(message.created_at) && (!nextUser || parsedTime(candidate.created_at) < parsedTime(nextUser.created_at)));
      const assistant = assistantMessage ? assistantFor(runId, phaseEvents, assistantMessage) : phaseEvents.length ? assistantFor(runId, phaseEvents) : emptyAssistant(message.delivery_status === "pending");
      return { id: message.id, runId, user: { id: message.id, content: textPart(message) ?? "", createdAt: message.created_at, deliveryStatus: message.delivery_status ?? "sent" }, assistant, anchor: validTime(message.created_at) } satisfies AgentThreadTurn;
    });
    const assignedAssistants = new Set(phaseTurns.map((turn) => turn.assistant.messageId).filter(Boolean));
    const orphanAssistants = messages.filter((message) => message.role === "assistant" && !assignedAssistants.has(message.id)).map((message) => ({ id: message.id, runId, assistant: assistantFor(runId, [], message), anchor: validTime(message.created_at) } satisfies AgentThreadTurn));
    turns.push(...phaseTurns, ...orphanAssistants);
    if (!users.length && events.length) {
      const started = events.find((event) => event.type === "turn.started");
      turns.push({ id: `${runId}:user`, runId, user: { id: `${runId}:user`, content: started?.text ?? "", createdAt: started?.timestamp, deliveryStatus: "sent" }, assistant: assistantFor(runId, events), anchor: started?.timestamp ?? earliestEventTime(events) });
    }
  }
  for (const [runId, events] of eventsByRun) {
    if (messagesByRun.has(runId)) continue;
    const started = events.find((event) => event.type === "turn.started");
    turns.push({ id: `${runId}:user`, runId, user: { id: `${runId}:user`, content: started?.text ?? "", createdAt: started?.timestamp, deliveryStatus: "sent" }, assistant: assistantFor(runId, events), anchor: started?.timestamp ?? earliestEventTime(events) });
  }
  return { turns: turns.sort(compareAnchors) };
}
