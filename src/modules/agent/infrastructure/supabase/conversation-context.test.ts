import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { CONVERSATION_CONTEXT_MESSAGE_LIMIT, SupabaseAgentConversationContext } from "./conversation-context";

describe("SupabaseAgentConversationContext", () => {
  it("loads only prior semantic messages in chronological order", async () => {
    const runQuery = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    runQuery.select.mockReturnValue(runQuery); runQuery.eq.mockReturnValue(runQuery);
    runQuery.single.mockResolvedValue({ data: { state: { conversationId: "conversation-1" } }, error: null });
    const messageQuery = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), neq: vi.fn(), order: vi.fn(), limit: vi.fn() };
    messageQuery.select.mockReturnValue(messageQuery); messageQuery.eq.mockReturnValue(messageQuery); messageQuery.in.mockReturnValue(messageQuery); messageQuery.neq.mockReturnValue(messageQuery); messageQuery.order.mockReturnValue(messageQuery);
    messageQuery.limit.mockResolvedValue({ data: [
      { id: "m-4", role: "tool", parts: [{ type: "text", text: "tool output" }], run_id: "run-old", created_at: "2026-08-28T04:00:00Z" },
      { id: "m-3", role: "assistant", parts: [{ type: "text", text: "B" }], run_id: "run-old", created_at: "2026-08-28T03:00:00Z" },
      { id: "m-2", role: "user", parts: [{ type: "text", text: "A" }], run_id: "run-old", created_at: "2026-08-28T02:00:00Z" },
    ], error: null });
    const from = vi.fn().mockReturnValueOnce(runQuery).mockReturnValueOnce(messageQuery);
    const context = await new SupabaseAgentConversationContext({ from } as unknown as SupabaseClient).loadPriorMessages("run-current");
    expect(context.messages).toEqual([{ role: "user", content: "A" }, { role: "assistant", content: "B" }]);
    expect(context.messages.some((message) => message.role === "tool")).toBe(false);
    expect(messageQuery.in).toHaveBeenCalledWith("role", ["user", "assistant"]);
  });

  it("reports truncation at the bounded recent-history boundary", async () => {
    const runQuery = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    runQuery.select.mockReturnValue(runQuery); runQuery.eq.mockReturnValue(runQuery);
    runQuery.single.mockResolvedValue({ data: { state: { conversationId: "conversation-2" } }, error: null });
    const rows = Array.from({ length: CONVERSATION_CONTEXT_MESSAGE_LIMIT + 1 }, (_, index) => ({ id: `m-${index}`, role: "user", parts: [{ type: "text", text: `message-${index}` }], run_id: "old-run", created_at: new Date(2026, 7, 28, 0, index).toISOString() }));
    const messageQuery = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), neq: vi.fn(), order: vi.fn(), limit: vi.fn() };
    messageQuery.select.mockReturnValue(messageQuery); messageQuery.eq.mockReturnValue(messageQuery); messageQuery.in.mockReturnValue(messageQuery); messageQuery.neq.mockReturnValue(messageQuery); messageQuery.order.mockReturnValue(messageQuery); messageQuery.limit.mockResolvedValue({ data: rows, error: null });
    const from = vi.fn().mockReturnValueOnce(runQuery).mockReturnValueOnce(messageQuery);
    const context = await new SupabaseAgentConversationContext({ from } as unknown as SupabaseClient).loadPriorMessages("new-run");
    expect(context.messages).toHaveLength(CONVERSATION_CONTEXT_MESSAGE_LIMIT);
    expect(context.truncated).toBe(true);
    expect(context.loadedCount).toBe(CONVERSATION_CONTEXT_MESSAGE_LIMIT);
    expect(messageQuery.limit).toHaveBeenCalledWith(CONVERSATION_CONTEXT_MESSAGE_LIMIT + 1);
  });

  it("writes full durable history oldest to newest without reversing it", async () => {
    const runQuery = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    runQuery.select.mockReturnValue(runQuery); runQuery.eq.mockReturnValue(runQuery);
    runQuery.single.mockResolvedValue({ data: { state: { conversationId: "conversation-full" } }, error: null });
    const messageQuery = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), order: vi.fn(), range: vi.fn() };
    messageQuery.select.mockReturnValue(messageQuery); messageQuery.eq.mockReturnValue(messageQuery); messageQuery.in.mockReturnValue(messageQuery); messageQuery.order.mockReturnValue(messageQuery);
    messageQuery.range.mockResolvedValue({ data: [
      { id: "m-1", role: "user", parts: [], run_id: "r1", created_at: "2026-08-28T10:00:00Z" },
      { id: "m-2", role: "assistant", parts: [], run_id: "r1", created_at: "2026-08-28T10:01:00Z" },
      { id: "m-3", role: "user", parts: [], run_id: "r2", created_at: "2026-08-28T10:02:00Z" },
    ], error: null });
    const from = vi.fn().mockReturnValueOnce(runQuery).mockReturnValueOnce(messageQuery);
    const history = await new SupabaseAgentConversationContext({ from } as unknown as SupabaseClient).loadFullHistory("run-current");
    expect(history.map((message) => message.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(messageQuery.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: true });
  });
});
