import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSupabaseUser } from "@/infrastructure/supabase/server";

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

/** Keyset-paginated durable conversation history, oldest-to-newest per page. */
export async function GET(request: Request) {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { client } = await requireSupabaseUser();
    const conversation = await client.from("conversations").select("id").eq("task_id", input.taskId).maybeSingle();
    if (conversation.error) throw new Error(conversation.error.message);
    if (!conversation.data) return NextResponse.json({ messages: [], nextCursor: null });
    let query = client.from("messages")
      .select("id, role, parts, run_id, created_at, message_key")
      .eq("conversation_id", conversation.data.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(input.limit + 1);
    if (input.before) {
      const cursor = decodeCursor(input.before);
      query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    }
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    const rows = result.data ?? [];
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit).reverse();
    const oldest = page[0];
    return NextResponse.json({
      conversationId: conversation.data.id,
      messages: page,
      nextCursor: hasMore && oldest ? encodeCursor(oldest.created_at as string, oldest.id as string) : null,
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error && error.message === "INVALID_CURSOR") {
      return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    return NextResponse.json({ code: "CONVERSATION_HISTORY_FAILED" }, { status: 500 });
  }
}
