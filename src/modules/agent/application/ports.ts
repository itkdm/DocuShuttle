import type { AgentRun } from "../domain/model";
import type { AgentImageAttachment } from "./message-parts";
import type { AgentLoopMessage } from "./loop";

export type AgentConversationContext = {
  conversationId?: string;
  messages: AgentLoopMessage[];
  loadedCount: number;
  truncated: boolean;
  limit: number;
};

/** Loads only canonical semantic messages for the beginning of a new run. */
export interface AgentConversationContextPort {
  loadPriorMessages(runId: string): Promise<AgentConversationContext>;
}

export interface AgentRunStore {
  load(runId: string): Promise<AgentRun | null>;
  createForTask(input: { taskId: string; ownerUserId: string; now: string; goal?: string; clientMessageId?: string; attachments?: readonly AgentImageAttachment[] }): Promise<AgentRun>;
}
