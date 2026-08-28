import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const internal = { checkpoint: { status: "completed", conversationId: "private-conversation", iterations: 2, toolCallCount: 1, pendingResolution: { type: "approval" }, messages: [{ role: "assistant", content: "", reasoning: "PRIVATE_REASONING_SENTINEL_123" }], finalText: "恢复完成", permissionMode: "default" }, events: [] };
  const runner = { recover: vi.fn(async () => internal) };
  const client = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { task_id: "task-1" }, error: null }) }) }) }) };
  return { internal, runner, client };
});

vi.mock("@/infrastructure/supabase/server", () => ({ requireSupabaseIdentity: vi.fn(async () => ({ client: harness.client })) }));
vi.mock("@/infrastructure/observability", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/modules/agent/application/loop", () => ({ AgentLoopRunner: vi.fn(function () { return harness.runner; }) }));
vi.mock("@/modules/agent/application/document-tools", () => ({ createDocumentTools: vi.fn(() => []) }));
vi.mock("@/modules/agent/application/document-version-tools", () => ({ createDocumentVersionTools: vi.fn(() => []) }));
vi.mock("@/modules/agent/application/source-context-tools", () => ({ createSourceContextTools: vi.fn(() => []) }));
vi.mock("@/modules/agent/infrastructure/openai-compatible-model", () => ({ createOpenAICompatibleAgentModelFromEnvironment: vi.fn(() => ({})) }));
vi.mock("@/modules/agent/infrastructure/supabase/loop-persistence", () => ({ SupabaseAgentLoopStore: vi.fn(function () { return {}; }) }));
vi.mock("@/modules/agent/infrastructure/supabase/working-document-access", () => ({ SupabaseWorkingDocumentAccess: vi.fn(function () { return {}; }) }));
vi.mock("@/modules/agent/infrastructure/supabase/document-version-access", () => ({ SupabaseDocumentVersionAccess: vi.fn(function () { return {}; }) }));
vi.mock("@/modules/agent/infrastructure/supabase/source-context", () => ({ SupabaseSourceDocumentContext: vi.fn(function () { return {}; }) }));
vi.mock("@/modules/agent/infrastructure/supabase/conversation-context", () => ({ SupabaseAgentConversationContext: vi.fn(function () { return {}; }) }));
vi.mock("@/modules/documents", () => ({ OoxmlPreservationKernel: vi.fn(function () { return {}; }) }));

import { POST, PUT } from "./route";

const params = Promise.resolve({ runId: "run-1" });

describe("agent recovery public runtime boundary", () => {
  it("redacts private checkpoint fields from recovery JSON", async () => {
    const response = await POST(new Request("http://localhost/api/agent/runs/run-1/loop/recover"), { params });
    const body = await response.text();
    expect(body).toContain("恢复完成");
    expect(body).not.toContain("PRIVATE_REASONING_SENTINEL_123");
    expect(body).not.toContain("messages");
    expect(body).not.toContain("pendingResolution");
  });

  it("redacts private checkpoint fields from recovery SSE result", async () => {
    const response = await PUT(new Request("http://localhost/api/agent/runs/run-1/loop/recover", { method: "PUT" }), { params });
    const body = await response.text();
    expect(body).toContain("event: result");
    expect(body).not.toContain("PRIVATE_REASONING_SENTINEL_123");
    expect(body).not.toContain("messages");
    expect(body).not.toContain("pendingResolution");
  });
});
