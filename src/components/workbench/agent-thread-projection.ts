import type { BrowserAgentLoopResult, BrowserConversationMessage } from "@/modules/agent/browser-runtime";
import { mergeTimelineEvents } from "./agent-timeline";

export type AgentThreadMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  runId?: string;
  status?: "pending" | "sent" | "failed";
};

export type AgentThreadProjection = {
  messages: readonly AgentThreadMessage[];
  events: readonly BrowserAgentLoopResult["events"][number][];
};

const textPart = (message: BrowserConversationMessage) => message.parts.find((part) => part.type === "text")?.text;

export function projectAgentThread(input: {
  messages: readonly BrowserConversationMessage[];
  historicalEvents: readonly BrowserAgentLoopResult["events"][number][];
  activeEvents: readonly BrowserAgentLoopResult["events"][number][];
}): AgentThreadProjection {
  const messages = input.messages.flatMap((message) => {
    const text = textPart(message);
    if (!text || (message.role !== "user" && message.role !== "assistant")) return [];
    return [{
      id: message.id,
      role: message.role === "user" ? "user" as const : "agent" as const,
      text,
      runId: message.run_id ?? undefined,
      status: message.delivery_status ?? "sent",
    }];
  });
  return {
    messages,
    events: mergeTimelineEvents(input.historicalEvents, input.activeEvents),
  };
}

export function projectLegacyConversation(messages: readonly { role: "system" | "user" | "assistant" | "tool"; content: string }[]): AgentThreadMessage[] {
  return messages.flatMap((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    return [{ id: `legacy:${message.role}:${index}`, role: message.role === "user" ? "user" as const : "agent" as const, text: message.content, status: "sent" as const }];
  });
}
