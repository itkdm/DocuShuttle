import { useCallback, useReducer } from "react";
import type { BrowserAgentLoopResult } from "@/modules/agent/browser-runtime";

export type ConversationMessage = { id?: string; role: "user" | "agent"; text: string; runId?: string; createdAt?: string; status?: "pending" | "sent" | "failed" };
type Event = BrowserAgentLoopResult["events"][number];
type State = { conversation: ConversationMessage[]; loopResult?: BrowserAgentLoopResult; liveEvents: Event[]; timelineHistory: Event[] };
type Action =
  | { type: "conversation.set"; value: ConversationMessage[] | ((value: ConversationMessage[]) => ConversationMessage[]) }
  | { type: "loop.set"; value?: BrowserAgentLoopResult }
  | { type: "live.set"; value: Event[] | ((value: Event[]) => Event[]) }
  | { type: "history.set"; value: Event[] | ((value: Event[]) => Event[]) };

const initialState: State = { conversation: [], liveEvents: [], timelineHistory: [] };

function reducer(state: State, action: Action): State {
  if (action.type === "conversation.set") return { ...state, conversation: typeof action.value === "function" ? action.value(state.conversation) : action.value };
  if (action.type === "loop.set") return { ...state, loopResult: action.value };
  if (action.type === "live.set") return { ...state, liveEvents: typeof action.value === "function" ? action.value(state.liveEvents) : action.value };
  return { ...state, timelineHistory: typeof action.value === "function" ? action.value(state.timelineHistory) : action.value };
}

export function useConversationStore() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const setConversation = useCallback((value: ConversationMessage[] | ((value: ConversationMessage[]) => ConversationMessage[])) => dispatch({ type: "conversation.set", value }), []);
  const setLoopResult = useCallback((value?: BrowserAgentLoopResult) => dispatch({ type: "loop.set", value }), []);
  const setLiveEvents = useCallback((value: Event[] | ((value: Event[]) => Event[])) => dispatch({ type: "live.set", value }), []);
  const setTimelineHistory = useCallback((value: Event[] | ((value: Event[]) => Event[])) => dispatch({ type: "history.set", value }), []);
  return { ...state, setConversation, setLoopResult, setLiveEvents, setTimelineHistory };
}
