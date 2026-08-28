import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentConversationContext, AgentConversationContextPort } from "../../application/ports";
import type { AgentLoopMessage } from "../../application/loop";

export const CONVERSATION_CONTEXT_MESSAGE_LIMIT = 200;

type MessageRow = {
  id: string;
  role: string;
  parts: unknown;
  run_id: string | null;
  created_at: string;
};

const textFromParts = (parts: unknown): string => {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
};

const toSemanticMessage = (row: MessageRow): AgentLoopMessage | undefined => {
  if (row.role !== "user" && row.role !== "assistant") return undefined;
  const content = textFromParts(row.parts);
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
}
