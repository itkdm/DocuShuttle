import type { AgentEvent } from "@/modules/agent/application/events";

export type AgentActivity =
  | { type: "note"; id: string; text: string }
  | { type: "tool"; id: string; callId: string; name: string; state: "running" | "completed" | "failed" | "approval"; input?: unknown; output?: unknown; error?: string; durationMs?: number };

export type AgentTurnEventState = {
  readonly activities: readonly AgentActivity[];
  readonly streamingContent: string;
  readonly textBuffer: string;
};


const callIdOf = (event: AgentEvent) => String((event as { callId?: unknown }).callId ?? "unknown");
const toolNameOf = (event: AgentEvent) => "name" in event ? event.name : "document_operation";

const toolIndexByCallId = (activities: readonly AgentActivity[], callId: string) => activities.findIndex((activity) => activity.type === "tool" && activity.callId === callId);

const upsertTool = (activities: AgentActivity[], event: AgentEvent, state: Extract<AgentActivity, { type: "tool" }>['state']) => {
  const callId = callIdOf(event);
  const index = toolIndexByCallId(activities, callId);
  const input = "input" in event ? event.input : undefined;
  const current = index >= 0 ? activities[index] : undefined;
  if (current?.type === "tool") {
    activities[index] = { ...current, name: toolNameOf(event), state, ...(input !== undefined ? { input } : {}) };
    return index;
  }
  activities.push({ type: "tool", id: event.eventId ?? `${callId}:tool`, callId, name: toolNameOf(event), state, ...(input !== undefined ? { input } : {}) });
  return activities.length - 1;
};

const flushTextBeforeTool = (activities: AgentActivity[], text: string, runId: string) => {
  if (text) activities.push({ type: "note", id: `${runId}:note:${activities.filter((activity) => activity.type === "note").length}`, text });
};

export function reduceAgentEvent(state: AgentTurnEventState, event: AgentEvent, runId: string): AgentTurnEventState {
  const activities = [...state.activities];
  if (event.type === "model.delta") {
    const text = event.text ?? "";
    return { ...state, activities, textBuffer: `${state.textBuffer}${text}` };
  } else if (event.type === "tool.started" || event.type === "approval.required") {
    flushTextBeforeTool(activities, state.textBuffer, runId);
    upsertTool(activities, event, event.type === "approval.required" ? "approval" : "running");
    return { ...state, activities, textBuffer: "" };
  } else if (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "approval.resolved") {
    const callId = callIdOf(event);
    const index = toolIndexByCallId(activities, callId);
    const current = index >= 0 && activities[index].type === "tool" ? activities[index] as Extract<AgentActivity, { type: "tool" }> : undefined;
    if (event.type === "tool.completed") {
      const target = current ?? { type: "tool" as const, id: `${runId}:tool:${callId}`, callId, name: event.name, state: "running" as const };
      const completed = { ...target, name: event.name, state: "completed" as const, output: event.output, durationMs: typeof event.output === "object" && event.output && "durationMs" in event.output ? Number(event.output.durationMs) : undefined };
      if (index >= 0) activities[index] = completed; else activities.push(completed);
    } else if (event.type === "tool.failed") {
      const target = current ?? { type: "tool" as const, id: `${runId}:tool:${callId}`, callId, name: event.name, state: "running" as const };
      const failed = { ...target, name: event.name, state: "failed" as const, error: event.error, durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined };
      if (index >= 0) activities[index] = failed; else activities.push(failed);
    } else {
      const target = current ?? { type: "tool" as const, id: `${runId}:tool:${callId}`, callId, name: event.name, state: "running" as const };
      const resolved = { ...target, name: event.name, state: event.decision === "approved" ? "running" as const : "failed" as const, error: event.decision === "rejected" ? "已拒绝" : undefined };
      if (index >= 0) activities[index] = resolved; else activities.push(resolved);
    }
  } else if (event.type === "assistant.message") {
    return { ...state, activities, streamingContent: event.text ?? "", textBuffer: "" };
  }
  return { ...state, activities };
}

export function reduceAgentEvents(events: readonly AgentEvent[], runId: string): AgentTurnEventState {
  return events.reduce<AgentTurnEventState>((state, event) => reduceAgentEvent(state, event, runId), { activities: [], streamingContent: "", textBuffer: "" });
}
