import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const internal = {
    checkpoint: { status: "completed", conversationId: "private-conversation", iterations: 2, toolCallCount: 1, pendingResolution: { type: "approval" }, messages: [{ role: "assistant", content: "", reasoning: "PRIVATE_REASONING_SENTINEL_123" }], finalText: "完成", permissionMode: "default" },
    events: [],
  };
  const runner = { runWithPermission: vi.fn(async () => internal) };
  const client = { from: (table: string) => table === "agent_run_events"
    ? { select: () => ({ eq: () => ({ gt: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }
    : {},
  };
  return { internal, runner, client };
});

vi.mock("@/infrastructure/supabase/server", () => ({ requireSupabaseIdentity: vi.fn(async () => ({ client: harness.client })) }));
vi.mock("@/infrastructure/observability", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, withLogContext: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock("@/modules/agent/application/loop", () => ({ AgentLoopRunner: vi.fn(function () { return harness.runner; }) }));
vi.mock("@/modules/agent/application/document-tools", () => ({ createDocumentTools: vi.fn(() => []) }));
vi.mock("@/modules/agent/application/document-version-tools", () => ({ createDocumentVersionTools: vi.fn(() => []) }));
vi.mock("@/modules/agent/application/source-context-tools", () => ({ createSourceContextTools: vi.fn(() => []) }));
vi.mock("@/modules/agent/infrastructure/openai-compatible-model", () => ({ createOpenAICompatibleAgentModelFromEnvironment: vi.fn(() => ({})) }));
vi.mock("@/modules/agent/infrastructure/supabase/loop-persistence", () => ({ SupabaseAgentLoopStore: vi.fn(function () { return { load: vi.fn(async () => harness.internal.checkpoint), loadBootstrap: vi.fn(async () => ({ taskId: "task-1", context: { messages: [] } })) }; }) }));
vi.mock("@/modules/agent/infrastructure/supabase/working-document-access", () => ({ SupabaseWorkingDocumentAccess: vi.fn(function () { return {}; }) }));
vi.mock("@/modules/agent/infrastructure/supabase/document-version-access", () => ({ SupabaseDocumentVersionAccess: vi.fn(function () { return {}; }) }));
vi.mock("@/modules/agent/infrastructure/supabase/source-context", () => ({ SupabaseSourceDocumentContext: vi.fn(function () { return {}; }) }));
vi.mock("@/modules/agent/infrastructure/supabase/conversation-context", () => ({ SupabaseAgentConversationContext: vi.fn(function () { return {}; }) }));
vi.mock("@/modules/documents", () => ({ OoxmlPreservationKernel: vi.fn(function () { return {}; }) }));

import { GET, POST, PUT } from "./route";

const params = Promise.resolve({ runId: "run-1" });
const input = () => new Request("http://localhost/api/agent/runs/run-1/loop", { method: "POST", body: JSON.stringify({ message: "检查", permissionMode: "default" }), headers: { "content-type": "application/json" } });

describe("agent loop public runtime boundary", () => {
  it("redacts replay GET checkpoint transcript", async () => {
    const response = await GET(new Request("http://localhost/api/agent/runs/run-1/loop"), { params });
    const body = await response.text();
    expect(body).toContain("completed");
    expect(body).not.toContain("PRIVATE_REASONING_SENTINEL_123");
    expect(body).not.toContain("messages");
    expect(body).not.toContain("pendingResolution");
  });

  it("redacts POST and PUT result payloads", async () => {
    const postBody = await (await POST(input(), { params })).text();
    const putBody = await (await PUT(new Request("http://localhost/api/agent/runs/run-1/loop", { method: "PUT", body: JSON.stringify({ message: "检查", permissionMode: "default" }), headers: { "content-type": "application/json" } }), { params })).text();
    for (const body of [postBody, putBody]) {
      expect(body).toContain("completed");
      expect(body).not.toContain("PRIVATE_REASONING_SENTINEL_123");
      expect(body).not.toContain("messages");
      expect(body).not.toContain("pendingResolution");
    }
  });
});
