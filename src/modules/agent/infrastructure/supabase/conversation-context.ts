import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentConversationContext, AgentConversationContextPort, AgentDurableConversationMessage } from "../../application/ports";
import type { AgentLoopMessage } from "../../application/loop";
import { describeAgentImages, imagePartsFromMessageParts, textFromAgentMessageParts } from "../../application/message-parts";

export const CONVERSATION_CONTEXT_MESSAGE_LIMIT = 200;

type MessageRow = {
  id: string;
  role: string;
  parts: unknown;
  run_id: string | null;
  created_at: string;
};

const toSemanticMessage = (row: MessageRow): AgentLoopMessage | undefined => {
  if (row.role !== "user" && row.role !== "assistant") return undefined;
  const content = `${textFromAgentMessageParts(row.parts).trim()}${describeAgentImages(imagePartsFromMessageParts(row.parts))}`;
  return content ? { role: row.role, content } : undefined;
};

/**
 * Conversation history is a read-only seed for a new run. Runtime checkpoint,
 * event, tool, receipt, and interaction data never cross this boundary.
 */
export class SupabaseAgentConversationContext implements AgentConversationContextPort {
  constructor(private readonly client: SupabaseClient, private readonly bootstrap?: AgentConversationContext) {}

  async loadPriorMessages(runId: string): Promise<AgentConversationContext> {
    if (this.bootstrap) return this.bootstrap;
    const run = await this.client.from("agent_runs").select("state").eq("id", runId).single();
    if (run.error) throw new Error(`Unable to load run conversation: ${run.error.message}`);
    const conversationId = (run.data?.state as { conversationId?: unknown } | null)?.conversationId;
    if (typeof conversationId !== "string" || !conversationId) {
      return { messages: [], loadedCount: 0, truncated: false, limit: CONVERSATION_CONTEXT_MESSAGE_LIMIT };
    }

    const result = await this.client
      .from("messages")
      .select("id, role, parts, run_id, created_at")
      .eq("conversation_id", conversationId)
      .in("role", ["user", "assistant"])
      .neq("run_id", runId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(CONVERSATION_CONTEXT_MESSAGE_LIMIT + 1);
    if (result.error) throw new Error(`Unable to load conversation context: ${result.error.message}`);

    const rows = (result.data ?? []) as MessageRow[];
    const truncated = rows.length > CONVERSATION_CONTEXT_MESSAGE_LIMIT;
    const selected = rows.slice(0, CONVERSATION_CONTEXT_MESSAGE_LIMIT);
    const messages = selected.map(toSemanticMessage).filter((message): message is AgentLoopMessage => Boolean(message)).reverse();
    return { conversationId, messages, loadedCount: messages.length, truncated, limit: CONVERSATION_CONTEXT_MESSAGE_LIMIT };
  }

  async loadFullHistory(runId: string): Promise<AgentDurableConversationMessage[]> {
    let conversationId = this.bootstrap?.conversationId;
    if (!conversationId) {
      const run = await this.client.from("agent_runs").select("state").eq("id", runId).single();
      conversationId = (run.data?.state as { conversationId?: string } | null)?.conversationId;
    }
    if (!conversationId) return [];
    const rows: AgentDurableConversationMessage[] = [];
    let offset = 0;
    while (true) {
      const query = this.client.from("messages").select("id, role, parts, run_id, created_at").eq("conversation_id", conversationId).in("role", ["user", "assistant"]).order("created_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + 499);
      const result = await query;
      if (result.error) throw new Error(`Unable to load durable conversation history: ${result.error.message}`);
      const page = (result.data ?? []) as AgentDurableConversationMessage[];
      rows.push(...page);
      if (page.length < 500) break;
      offset += page.length;
    }
    return rows.reverse();
  }
}
