import { useCallback, useReducer } from "react";
import type { BrowserAgentLoopResult } from "@/modules/agent/browser-runtime";
import type { AgentEvent } from "@/modules/agent/application/events";
import type { AgentImageAttachment } from "@/modules/agent/application/message-parts";

export type ConversationMessage = { id?: string; role: "user" | "agent"; text: string; images?: readonly AgentImageAttachment[]; runId?: string; createdAt?: string; status?: "pending" | "sent" | "failed" };
type Event = AgentEvent;
type Updater<T> = T | ((value: T) => T);
type State = { messages: ConversationMessage[]; loopResult?: BrowserAgentLoopResult; activeEvents: Event[]; historicalEvents: Event[] };
type Action =
  | { type: "messages.set"; value: Updater<ConversationMessage[]> }
  | { type: "loop.set"; value?: BrowserAgentLoopResult }
  | { type: "active-events.set"; value: Updater<Event[]> }
  | { type: "historical-events.set"; value: Updater<Event[]> };

const apply = <T,>(current: T, value: Updater<T>) => typeof value === "function" ? (value as (value: T) => T)(current) : value;
const initialState: State = { messages: [], activeEvents: [], historicalEvents: [] };

function reducer(state: State, action: Action): State {
  if (action.type === "messages.set") return { ...state, messages: apply(state.messages, action.value) };
  if (action.type === "loop.set") return { ...state, loopResult: action.value };
  if (action.type === "active-events.set") return { ...state, activeEvents: apply(state.activeEvents, action.value) };
  return { ...state, historicalEvents: apply(state.historicalEvents, action.value) };
}

export function useConversationStore() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const setMessages = useCallback((value: Updater<ConversationMessage[]>) => dispatch({ type: "messages.set", value }), []);
  const setLoopResult = useCallback((value?: BrowserAgentLoopResult) => dispatch({ type: "loop.set", value }), []);
  const setActiveEvents = useCallback((value: Updater<Event[]>) => dispatch({ type: "active-events.set", value }), []);
  const setHistoricalEvents = useCallback((value: Updater<Event[]>) => dispatch({ type: "historical-events.set", value }), []);
  return { ...state, setMessages, setLoopResult, setActiveEvents, setHistoricalEvents };
}
