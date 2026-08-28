import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, from, requireSupabaseIdentity, logger } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  requireSupabaseIdentity: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/infrastructure/supabase/server", () => ({ requireSupabaseIdentity }));
vi.mock("@/infrastructure/observability", () => ({ logger }));

import { GET } from "./route";

const taskId = "f9660b6c-ee52-4732-8c75-65bf2240dad1";
const message = (id: string, createdAt: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
  run_id: "run-1",
  created_at: createdAt,
  message_key: `key-${id}`,
  delivery_status: "sent",
});

const request = (query = "") => new Request(`http://localhost/api/agent/messages?taskId=${taskId}&limit=2${query}`);

describe("GET /api/agent/messages", () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
    requireSupabaseIdentity.mockReset().mockResolvedValue({ client: { rpc, from } });
    logger.info.mockReset();
  });

  it("uses exactly one RPC and no conversations/messages Data API queries", async () => {
    rpc.mockResolvedValue({ data: { conversationId: "conversation-1", messages: [message("m-1", "2026-08-28T00:00:00Z")] }, error: null });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("list_conversation_messages_page", expect.objectContaining({ p_task_id: taskId, p_limit: 3 }));
    expect(from).not.toHaveBeenCalled();
  });

  it("keeps the empty conversation response compatible", async () => {
    rpc.mockResolvedValue({ data: { conversationId: null, messages: [] }, error: null });

    await expect((await GET(request())).json()).resolves.toEqual({ conversationId: null, messages: [], nextCursor: null });
  });

  it("returns pages oldest-to-newest and encodes the oldest item as the next cursor", async () => {
    rpc.mockResolvedValue({
      data: {
        conversationId: "conversation-1",
        messages: [message("m-3", "2026-08-28T00:03:00Z"), message("m-2", "2026-08-28T00:02:00Z"), message("m-1", "2026-08-28T00:01:00Z")],
      },
      error: null,
    });

    const body = await (await GET(request())).json();

    expect(body.messages.map((item: { id: string }) => item.id)).toEqual(["m-2", "m-3"]);
    expect(body.nextCursor).toBe(Buffer.from(JSON.stringify({ createdAt: "2026-08-28T00:02:00Z", id: "m-2" }), "utf8").toString("base64url"));
  });

  it("passes a decoded keyset cursor to the RPC", async () => {
    rpc.mockResolvedValue({ data: { conversationId: "conversation-1", messages: [] }, error: null });
    const before = Buffer.from(JSON.stringify({ createdAt: "2026-08-28T00:01:00Z", id: "m-1" }), "utf8").toString("base64url");

    await GET(request(`&before=${before}`));

    expect(rpc).toHaveBeenCalledWith("list_conversation_messages_page", expect.objectContaining({
      p_before_created_at: "2026-08-28T00:01:00Z",
      p_before_id: "m-1",
    }));
  });
});
