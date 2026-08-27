import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpenAICompatibleAgentModel } from "../infrastructure/openai-compatible-model";

describe("OpenAI-compatible Agent model adapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses native tool calls and sends native assistant/tool message parts", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const body = requests.length === 1
        ? { choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect_document", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }
        : { choices: [{ index: 0, message: { role: "assistant", content: "文档已检查。" }, finish_reason: "stop" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const model = new OpenAICompatibleAgentModel({ apiKey: "test", baseUrl: "https://gateway.test/v1", model: "test-model" });
    const tool = { name: "inspect_document", description: "Inspect", inputSchema: z.object({}), async execute() { return {}; } };
    const first = await model.decide({ messages: [{ role: "user", content: "检查" }], tools: [tool] });
    expect(first).toEqual({ kind: "tool_calls", calls: [{ id: "call-1", name: "inspect_document", input: {} }] });
    const second = await model.decide({
      messages: [
        { role: "user", content: "检查" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "inspect_document", input: {} }] },
        { role: "tool", toolCallId: "call-1", toolName: "inspect_document", content: JSON.stringify({ revision: "r1" }) },
      ],
      tools: [tool],
    });
    expect(second).toEqual({ kind: "message", text: "文档已检查。" });
    const last = requests[1] as { messages: Array<{ role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }> };
    expect(last.messages.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls))).toBe(true);
    expect(last.messages.some((message) => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
  });

  it("supports ordinary conversation without selecting a document tool", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content: "你好，我可以直接回答，也可以在需要时读取文档。" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const model = new OpenAICompatibleAgentModel({ apiKey: "test", baseUrl: "https://gateway.test/v1", model: "test-model" });
    const result = await model.decide({ messages: [{ role: "user", content: "你好" }], tools: [] });
    expect(result).toEqual({ kind: "message", text: "你好，我可以直接回答，也可以在需要时读取文档。" });
  });

  it("maps the ask_user control tool to a durable HITL decision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "ask-1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ text: "要修改哪一段？" }) } }] }, finish_reason: "tool_calls" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const model = new OpenAICompatibleAgentModel({ apiKey: "test", baseUrl: "https://gateway.test/v1", model: "test-model" });
    const result = await model.decide({ messages: [{ role: "user", content: "帮我修改" }], tools: [] });
    expect(result).toEqual({ kind: "ask_user", text: "要修改哪一段？" });
  });
});
