export const AGENT_EVENT_TYPES = [
  "turn.started",
  "model.started",
  "model.completed",
  "model.delta",
  "assistant.message",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.required",
  "approval.resolved",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
] as const;

export type AgentEventType = typeof AGENT_EVENT_TYPES[number];

/** Event-specific fields. Identity and ordering belong to AgentEvent. */
export type AgentEventPayload =
  | { type: "turn.started"; text: string; clientMessageId?: string }
  | { type: "model.started"; text: string }
  | { type: "model.completed"; durationMs: number }
  | { type: "model.delta"; text: string; channel?: "commentary" | "reasoning_summary" | "final" }
  | { type: "assistant.message"; text: string }
  | { type: "tool.started"; callId: string; name: string; input: unknown }
  | { type: "tool.completed"; callId: string; name: string; output: unknown }
  | { type: "tool.failed"; callId: string; name: string; error: string; durationMs?: number }
  | { type: "approval.required"; callId: string; name: string; input: unknown }
  | { type: "approval.resolved"; callId: string; name: string; decision: "approved" | "rejected" }
  | { type: "turn.completed"; text: string }
  | { type: "turn.failed"; error: string }
  | { type: "turn.cancelled"; text: string };

export type AgentEvent = AgentEventPayload & {
  readonly eventId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly sequence?: number;
};

export type LiveAgentEvent = AgentEvent & { readonly sequence?: undefined };
export type DurableAgentEvent = AgentEvent & { readonly sequence: number };

export function createAgentEvent<TPayload extends AgentEventPayload>(runId: string, payload: TPayload): TPayload & Omit<LiveAgentEvent, keyof AgentEventPayload> {
  return {
    ...payload,
    eventId: crypto.randomUUID(),
    runId,
    timestamp: new Date().toISOString(),
  };
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.eventId === "string"
    && typeof event.runId === "string"
    && typeof event.timestamp === "string"
    && typeof event.type === "string"
    && (AGENT_EVENT_TYPES as readonly string[]).includes(event.type);
}

export function isDurableAgentEvent(value: unknown): value is DurableAgentEvent {
  return isAgentEvent(value) && typeof value.sequence === "number" && Number.isInteger(value.sequence) && value.sequence > 0;
}
