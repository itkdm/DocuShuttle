import type { AgentEvent } from "@/modules/agent/application/events";

export type AgentActivity =
  | { type: "note"; id: string; text: string }
  | { type: "tool"; id: string; callId: string; name: string; state: "running" | "completed" | "failed" | "approval"; input?: unknown; output?: unknown; error?: string; durationMs?: number };

export type AgentTurnEventState = {
  readonly activities: readonly AgentActivity[];
  readonly streamingContent: string;
  readonly textBuffer: string;
  readonly sawTool: boolean;
};


const callIdOf = (event: AgentEvent) => String((event as { callId?: unknown }).callId ?? "unknown");
const toolNameOf = (event: AgentEvent) => "name" in event ? event.name : "document_operation";

export function reduceAgentEvent(state: AgentTurnEventState, event: AgentEvent, runId: string): AgentTurnEventState {
  const activities = [...state.activities];
  if (event.type === "model.delta") {
    const text = event.text ?? "";
    if (state.sawTool) return { ...state, activities, streamingContent: `${state.streamingContent}${text}` };
    return { ...state, activities, textBuffer: `${state.textBuffer}${text}` };
  } else if (event.type === "tool.started" || event.type === "approval.required") {
    if (state.textBuffer) activities.push({ type: "note", id: `${runId}:note:${activities.length}`, text: state.textBuffer });
    activities.push({ type: "tool", id: event.eventId ?? `${runId}:tool:${callIdOf(event)}`, callId: callIdOf(event), name: toolNameOf(event), state: event.type === "approval.required" ? "approval" : "running", input: event.input });
    return { ...state, activities, sawTool: true, textBuffer: "" };
  } else if (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "approval.resolved") {
    const callId = callIdOf(event);
    const index = activities.findIndex((activity) => activity.type === "tool" && activity.callId === callId);
    if (index < 0) return state;
    const current = activities[index] as Extract<AgentActivity, { type: "tool" }>;
    activities[index] = event.type === "tool.completed"
      ? { ...current, state: "completed", output: event.output, durationMs: typeof event.output === "object" && event.output && "durationMs" in event.output ? Number(event.output.durationMs) : undefined }
      : event.type === "tool.failed"
        ? { ...current, state: "failed", error: event.error, durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined }
        : { ...current, state: event.decision === "approved" ? "running" : "failed", error: event.decision === "rejected" ? "已拒绝" : undefined };
  } else if (event.type === "assistant.message" && !state.streamingContent && !state.textBuffer) {
    return { ...state, activities, streamingContent: event.text ?? "" };
  }
  return { ...state, activities };
}

export function reduceAgentEvents(events: readonly AgentEvent[], runId: string): AgentTurnEventState {
  return events.reduce<AgentTurnEventState>((state, event) => reduceAgentEvent(state, event, runId), { activities: [], streamingContent: "", textBuffer: "", sawTool: false });
}
