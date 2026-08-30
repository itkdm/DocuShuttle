export const AGENT_EVENT_TYPES = [
  "turn.started",
  "model.started",
  "model.completed",
  "model.delta",
  "model.commentary",
  "assistant.message",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.required",
  "approval.resolved",
  "client_tool.required",
  "client_tool.resolved",
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
  | { type: "model.commentary"; text: string }
  | { type: "assistant.message"; text: string }
  | { type: "tool.started"; callId: string; name: string; input: unknown }
  | { type: "tool.completed"; callId: string; name: string; output: unknown }
  | { type: "tool.failed"; callId: string; name: string; error: string; durationMs?: number }
  | { type: "approval.required"; interactionId: string; callId: string; name: string; input: unknown }
  | { type: "approval.resolved"; interactionId: string; callId: string; name: string; decision: "approved" | "rejected" }
  | { type: "client_tool.required"; interactionId: string; callId: string; name: "capture_document_view"; target: "visible" }
  | { type: "client_tool.required"; interactionId: string; callId: string; name: "scroll_document_view"; kind: "relative"; direction: "up" | "down"; amount: "small" | "viewport" }
  | { type: "client_tool.required"; interactionId: string; callId: string; name: "scroll_document_view"; kind: "edge"; target: "top" | "bottom" }
  | ({ type: "client_tool.resolved"; interactionId: string; callId: string; name: "capture_document_view" } & { assetId: string; mimeType: "image/png"; sha256: string; pageNumber?: number; width: number; height: number; revision: string })
  | ({ type: "client_tool.resolved"; interactionId: string; callId: string; name: "scroll_document_view" } & { revision: string; beforeScrollTop: number; scrollTop: number; maxScrollTop: number; viewportHeight: number; moved: boolean; atTop: boolean; atBottom: boolean })
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
  if (typeof event.eventId !== "string"
    || typeof event.runId !== "string"
    || typeof event.timestamp !== "string"
    || typeof event.type !== "string"
    || !(AGENT_EVENT_TYPES as readonly string[]).includes(event.type)) return false;

  const hasField = (name: string) => Object.prototype.hasOwnProperty.call(event, name);
  const isString = (name: string) => typeof event[name] === "string";
  const isNumber = (name: string) => typeof event[name] === "number" && Number.isFinite(event[name]);
  const hasUnknownValue = (name: string) => hasField(name);
  const hasOnlyFields = (fields: readonly string[]) => Object.keys(event).every((key) => ["eventId", "runId", "timestamp", "type", "sequence", ...fields].includes(key));

  switch (event.type) {
    case "turn.started":
      return isString("text") && (!hasField("clientMessageId") || isString("clientMessageId"));
    case "model.started":
    case "assistant.message":
    case "turn.cancelled":
      return isString("text");
    case "model.completed":
      return isNumber("durationMs");
    case "model.delta":
      return isString("text")
        && (!hasField("channel") || event.channel === "commentary" || event.channel === "reasoning_summary" || event.channel === "final");
    case "model.commentary":
      return isString("text");
    case "tool.started":
      return isString("callId") && isString("name") && hasUnknownValue("input");
    case "approval.required":
      return isString("interactionId") && isString("callId") && isString("name") && hasUnknownValue("input");
    case "tool.completed":
      return isString("callId") && isString("name") && hasUnknownValue("output");
    case "tool.failed":
      return isString("callId") && isString("name") && isString("error")
        && (!hasField("durationMs") || isNumber("durationMs"));
    case "approval.resolved":
      return isString("interactionId") && isString("callId") && isString("name") && (event.decision === "approved" || event.decision === "rejected");
    case "client_tool.required":
      if (!isString("interactionId") || !isString("callId") || !isString("name")) return false;
      if (event.name === "capture_document_view") return hasOnlyFields(["interactionId", "callId", "name", "target"]) && event.target === "visible";
      if (event.name === "scroll_document_view") {
        return event.kind === "relative"
          ? hasOnlyFields(["interactionId", "callId", "name", "kind", "direction", "amount"]) && (event.direction === "up" || event.direction === "down") && (event.amount === "small" || event.amount === "viewport")
          : hasOnlyFields(["interactionId", "callId", "name", "kind", "target"]) && event.kind === "edge" && (event.target === "top" || event.target === "bottom");
      }
      return false;
    case "client_tool.resolved":
      if (!isString("interactionId") || !isString("callId") || !isString("name")) return false;
      if (event.name === "capture_document_view") return hasOnlyFields(["interactionId", "callId", "name", "assetId", "mimeType", "sha256", "pageNumber", "width", "height", "revision"]) && isString("assetId") && event.mimeType === "image/png" && isString("sha256")
        && isNumber("width") && (event.width as number) > 0 && isNumber("height") && (event.height as number) > 0 && isString("revision")
        && (!hasField("pageNumber") || (isNumber("pageNumber") && Number.isInteger(event.pageNumber as number) && (event.pageNumber as number) > 0));
      if (event.name === "scroll_document_view") return hasOnlyFields(["interactionId", "callId", "name", "revision", "beforeScrollTop", "scrollTop", "maxScrollTop", "viewportHeight", "moved", "atTop", "atBottom"]) && isString("revision") && isNumber("beforeScrollTop") && (event.beforeScrollTop as number) >= 0 && isNumber("scrollTop") && (event.scrollTop as number) >= 0
        && isNumber("maxScrollTop") && (event.maxScrollTop as number) >= 0 && isNumber("viewportHeight") && (event.viewportHeight as number) > 0
        && typeof event.moved === "boolean" && typeof event.atTop === "boolean" && typeof event.atBottom === "boolean";
      return false;
    case "turn.completed":
      return isString("text");
    case "turn.failed":
      return isString("error");
  }

  return false;
}

export function isDurableAgentEvent(value: unknown): value is DurableAgentEvent {
  return isAgentEvent(value) && typeof value.sequence === "number" && Number.isInteger(value.sequence) && value.sequence > 0;
}

/** Only structural activity is durable; token deltas belong to the live stream. */
export function shouldPersistAgentEvent(event: AgentEvent): boolean {
  return event.type !== "model.delta";
}
