import type { AgentEvent } from "@/modules/agent/application/events";

export type AgentActivity =
  | { type: "note"; id: string; text: string }
  | { type: "tool"; id: string; callId: string; name: string; state: "running" | "completed" | "failed" | "approval"; input?: unknown; output?: unknown; error?: string; errorDetails?: unknown; durationMs?: number };

export type AgentTurnEventState = {
  readonly activities: readonly AgentActivity[];
  readonly streamingContent: string;
  readonly activeNoteId?: string;
};


const callIdOf = (event: AgentEvent) => String((event as { callId?: unknown }).callId ?? "unknown");
const toolNameOf = (event: AgentEvent) => "name" in event ? event.name : "document_operation";
const parseToolErrorDetails = (error: string) => {
  try {
    const parsed = JSON.parse(error) as { error?: unknown; issues?: unknown };
    return parsed.error === "TOOL_INPUT_VALIDATION_FAILED" && Array.isArray(parsed.issues) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

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

const modelDeltaChannel = (event: AgentEvent) => {
  const channel = "channel" in event ? event.channel : undefined;
  return channel === "final" ? "final" : "note";
};

const endActiveNote = (state: AgentTurnEventState): AgentTurnEventState => ({ ...state, activeNoteId: undefined });

const appendLiveNote = (activities: AgentActivity[], state: AgentTurnEventState, event: AgentEvent, text: string, runId: string) => {
  if (!text) return state;
  if (state.activeNoteId) {
    const index = activities.findIndex((activity) => activity.type === "note" && activity.id === state.activeNoteId);
    const current = index >= 0 ? activities[index] : undefined;
    if (current?.type === "note") {
      activities[index] = { ...current, text: `${current.text}${text}` };
      return { ...state, activities };
    }
  }
  const id = event.eventId ?? `${runId}:note:${activities.filter((activity) => activity.type === "note").length}`;
  activities.push({ type: "note", id, text });
  return { ...state, activities, activeNoteId: id };
};

const appendDurableNote = (activities: AgentActivity[], state: AgentTurnEventState, event: AgentEvent, text: string, runId: string) => {
  if (!text) return endActiveNote(state);
  if (state.activeNoteId) {
    const index = activities.findIndex((activity) => activity.type === "note" && activity.id === state.activeNoteId);
    const current = index >= 0 ? activities[index] : undefined;
    if (current?.type === "note") {
      if (current.text === text) return endActiveNote({ ...state, activities });
      if (text.startsWith(current.text)) {
        activities[index] = { ...current, text };
        return endActiveNote({ ...state, activities });
      }
    }
  }
  activities.push({ type: "note", id: event.eventId ?? `${runId}:note:${activities.filter((activity) => activity.type === "note").length}`, text });
  return endActiveNote({ ...state, activities });
};

export function reduceAgentEvent(state: AgentTurnEventState, event: AgentEvent, runId: string): AgentTurnEventState {
  const activities = [...state.activities];
  if (event.type === "model.delta") {
    const text = event.text ?? "";
    if (modelDeltaChannel(event) === "final") return { ...state, activities, streamingContent: `${state.streamingContent}${text}`, activeNoteId: undefined };
    return appendLiveNote(activities, state, event, text, runId);
  } else if (event.type === "model.commentary") {
    return appendDurableNote(activities, state, event, event.text, runId);
  } else if (event.type === "tool.started" || event.type === "approval.required" || event.type === "client_tool.required") {
    upsertTool(activities, event, event.type === "approval.required" ? "approval" : "running");
    return endActiveNote({ ...state, activities });
  } else if (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "approval.resolved" || event.type === "client_tool.resolved") {
    const callId = callIdOf(event);
    const index = toolIndexByCallId(activities, callId);
    const current = index >= 0 && activities[index].type === "tool" ? activities[index] as Extract<AgentActivity, { type: "tool" }> : undefined;
    if (event.type === "tool.completed" || event.type === "client_tool.resolved") {
      const target = current ?? { type: "tool" as const, id: `${runId}:tool:${callId}`, callId, name: event.name, state: "running" as const };
      const completed = { ...target, name: event.name, state: "completed" as const, ...(event.type === "tool.completed" ? { output: event.output, durationMs: typeof event.output === "object" && event.output && "durationMs" in event.output ? Number(event.output.durationMs) : undefined } : {}) };
      if (index >= 0) activities[index] = completed; else activities.push(completed);
    } else if (event.type === "tool.failed") {
      const target = current ?? { type: "tool" as const, id: `${runId}:tool:${callId}`, callId, name: event.name, state: "running" as const };
      const errorDetails = parseToolErrorDetails(event.error);
      const failed = { ...target, name: event.name, state: "failed" as const, error: errorDetails ? "参数不符合要求" : event.error, ...(errorDetails ? { errorDetails } : {}), durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined };
      if (index >= 0) activities[index] = failed; else activities.push(failed);
    } else {
      const target = current ?? { type: "tool" as const, id: `${runId}:tool:${callId}`, callId, name: event.name, state: "running" as const };
      const resolved = { ...target, name: event.name, state: event.decision === "approved" ? "running" as const : "failed" as const, error: event.decision === "rejected" ? "已拒绝" : undefined };
      if (index >= 0) activities[index] = resolved; else activities.push(resolved);
    }
  } else if (event.type === "assistant.message") {
    const text = event.text ?? "";
    if (state.activeNoteId) {
      const index = activities.findIndex((activity) => activity.type === "note" && activity.id === state.activeNoteId);
      const activeNote = index >= 0 ? activities[index] : undefined;
      if (activeNote?.type === "note" && activeNote.text === text) activities.splice(index, 1);
    }
    return { ...state, activities, streamingContent: text, activeNoteId: undefined };
  }
  return { ...state, activities };
}

export function reduceAgentEvents(events: readonly AgentEvent[], runId: string): AgentTurnEventState {
  return events.reduce<AgentTurnEventState>((state, event) => reduceAgentEvent(state, event, runId), { activities: [], streamingContent: "" });
}
