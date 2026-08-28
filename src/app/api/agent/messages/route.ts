import { NextResponse } from "next/server";
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { logger } from "@/infrastructure/observability";
import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";

const querySchema = z.object({
  taskId: z.uuid(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const encodeCursor = (createdAt: string, id: string) => Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
const decodeCursor = (value: string) => {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: string; id?: string };
  if (!parsed.createdAt || !parsed.id) throw new Error("INVALID_CURSOR");
  return parsed;
};

type ConversationHistoryPage = {
  conversationId: string | null;
  messages: Array<{
    id: string;
    role: string;
    parts: unknown;
    run_id: string | null;
    created_at: string;
    message_key: string;
    delivery_status: string;
  }>;
};

/** Keyset-paginated durable conversation history, oldest-to-newest per page. */
export async function GET(request: Request) {
  const started = performance.now();
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { client } = await requireSupabaseIdentity();
    const cursor = input.before ? decodeCursor(input.before) : undefined;
    const rpcStarted = performance.now();
    const result = await client.rpc("list_conversation_messages_page", {
      p_task_id: input.taskId,
      p_before_created_at: cursor?.createdAt ?? null,
      p_before_id: cursor?.id ?? null,
      p_limit: input.limit + 1,
    });
    if (result.error) throw new Error(result.error.message);
    const payload = result.data as ConversationHistoryPage | null;
    const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId : null;
    const rows = Array.isArray(payload?.messages) ? payload.messages : [];
    logger.info("conversation.messages.rpc.completed", {
      durationMs: performance.now() - rpcStarted,
      messageCount: rows.length,
    });
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit).reverse();
    const oldest = page[0];
    const response = NextResponse.json({
      conversationId,
      messages: page,
      nextCursor: hasMore && oldest ? encodeCursor(oldest.created_at, oldest.id) : null,
    });
    logger.info("conversation.messages.list.completed", { durationMs: performance.now() - started, taskId: input.taskId, messageCount: page.length, hasMore });
    return response;
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error && error.message === "INVALID_CURSOR") {
      return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    logger.error("http.request.failed", { route: "/api/agent/messages", durationMs: performance.now() - started, error });
    return NextResponse.json({ code: "CONVERSATION_HISTORY_FAILED" }, { status: 500 });
  }
}
