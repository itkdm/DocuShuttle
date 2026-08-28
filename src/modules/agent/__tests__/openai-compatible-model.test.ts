import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { logger } from "@/infrastructure/observability";
import { OpenAICompatibleAgentModel } from "../infrastructure/openai-compatible-model";
import { createProviderFetchObserver } from "../infrastructure/provider-fetch-observer";

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

  it("preserves provider reasoning before tool calls in the next request", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const requests: Array<{ messages: Array<{ role: string; content: unknown; reasoning_content?: string; tool_calls?: unknown }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const body = requests.length === 1
        ? { choices: [{ index: 0, message: { role: "assistant", reasoning_content: "先读取文档事实", content: null, tool_calls: [{ id: "inspect-1", type: "function", function: { name: "inspect_document", arguments: "{}" } }, { id: "regions-1", type: "function", function: { name: "list_document_regions", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }
        : { choices: [{ index: 0, message: { role: "assistant", content: "已完成检查。" }, finish_reason: "stop" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const model = new OpenAICompatibleAgentModel({ apiKey: "test", baseUrl: "https://gateway.test/v1", model: "deepseek-v4-flash", provider: "deepseek", reasoningMode: "enabled" });
    const tool = { name: "inspect_document", description: "Inspect", inputSchema: z.object({}), async execute() { return {}; } };
    const first = await model.decide({ messages: [{ role: "user", content: "检查" }], tools: [tool] });
    expect(first).toMatchObject({ kind: "tool_calls", reasoning: "先读取文档事实", calls: [{ id: "inspect-1" }, { id: "regions-1" }] });
    await model.decide({ messages: [
      { role: "user", content: "检查" },
      { role: "assistant", content: "", reasoning: "先读取文档事实", toolCalls: [
        { id: "inspect-1", name: "inspect_document", input: {} },
        { id: "regions-1", name: "list_document_regions", input: {} },
      ] },
      { role: "tool", toolCallId: "inspect-1", toolName: "inspect_document", content: "{}" },
      { role: "tool", toolCallId: "regions-1", toolName: "list_document_regions", content: "{}" },
    ], tools: [tool] });
    const assistant = requests[1].messages.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({ reasoning_content: "先读取文档事实" });
    expect(assistant?.tool_calls).toHaveLength(2);
    expect(requests[1].messages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(infoSpy.mock.calls.map(([, metadata]) => JSON.stringify(metadata)).join("\n")).not.toContain("先读取文档事实");
  });

  it("sends explicit disabled thinking mode without private reasoning", async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "可以。" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const model = new OpenAICompatibleAgentModel({ apiKey: "test", baseUrl: "https://gateway.test/v1", model: "deepseek-v4-flash", provider: "deepseek", reasoningMode: "disabled" });
    await model.decide({ messages: [{ role: "user", content: "你好" }], tools: [] });
    expect(request?.thinking).toEqual({ type: "disabled" });
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

  it("records provider HTTP error details without logging the response body", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { type: "rate_limit", code: "429", message: "too many requests" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    })));

    const response = await createProviderFetchObserver({ provider: "openai-compatible", model: "test-model" })("https://gateway.test/v1/chat/completions");
    await response.text();
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith("agent.provider.response.error", expect.objectContaining({
      status: 429,
      errorBody: { type: "rate_limit", code: "429", message: "too many requests" },
    })), { timeout: 1000 });
  });

  it("records an empty successful stream separately from a provider request failure", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    const response = await createProviderFetchObserver({ provider: "openai-compatible", model: "test-model" })("https://gateway.test/v1/chat/completions");
    await response.arrayBuffer();
    expect(infoSpy).toHaveBeenCalledWith("agent.provider.response.headers", expect.objectContaining({ status: 200, contentType: "text/event-stream" }));
    expect(infoSpy).toHaveBeenCalledWith("agent.provider.stream.completed", expect.objectContaining({ status: 200, chunkCount: 0, bytesReceived: 0 }));
  });

  it("exposes a provider stream failure across the model retry boundary", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("upstream reset")); } }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    const model = new OpenAICompatibleAgentModel({ apiKey: "test", baseUrl: "https://gateway.test/v1", model: "test-model" });
    await expect(model.decide({ messages: [{ role: "user", content: "检查" }], tools: [], onTextDelta: () => undefined })).rejects.toThrow(/upstream reset|No output generated/);
    expect(errorSpy).toHaveBeenCalledWith("agent.provider.stream.failed", expect.objectContaining({ status: 200, chunkCount: 0, bytesReceived: 0, requestSequence: 2 }));
    expect(warnSpy).toHaveBeenCalledWith("agent.model.retry", expect.objectContaining({ reason: "empty_stream_failure", attempt: 1 }));
    expect(errorSpy.mock.calls.some(([event]) => event === "agent.model.failed")).toBe(true);
  });
});
