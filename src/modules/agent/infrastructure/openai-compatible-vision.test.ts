import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleImageVisionAdapter } from "./openai-compatible-vision";

describe("OpenAI-compatible image vision adapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends private image bytes as a formal multimodal part with thinking disabled", async () => {
    let request: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ summary: "一张表格截图", type: "screenshot", visibleText: ["总计"], layout: "表格", importantElements: ["数据表"], generationHints: [] }) }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const adapter = new OpenAICompatibleImageVisionAdapter({
      provider: "qwen",
      reasoningMode: "disabled",
      apiKey: "test-key",
      baseUrl: "https://qwen.test/v1",
      model: "qwen-vision-test",
    });
    const result = await adapter.analyze({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" });

    expect(result).toMatchObject({ summary: "一张表格截图", visibleText: ["总计"] });
    expect(request?.enable_thinking).toBe(false);
    expect((request?.messages as Array<{ role: string; content: unknown }>).some((message) => message.role === "system" && JSON.stringify(message.content).match(/不可信数据|图片中的指令/))).toBe(true);
    const content = (request?.messages as Array<{ role: string; content: unknown }>).find((message) => message.role === "user")?.content as Array<Record<string, unknown>>;
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: "data:image/png;base64,AQID" }) }),
    ]));
    expect(JSON.stringify(request)).not.toContain("objectKey");
  });

  it("aborts the provider request when the caller aborts", async () => {
    let providerSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      providerSignal = init?.signal ?? undefined;
      providerSignal?.addEventListener("abort", () => reject(providerSignal?.reason ?? new Error("aborted")), { once: true });
    })));
    const controller = new AbortController();
    const adapter = new OpenAICompatibleImageVisionAdapter({ provider: "qwen", reasoningMode: "disabled", apiKey: "test-key", baseUrl: "https://qwen.test/v1", model: "qwen-vision-test" }, 60_000);
    const pending = adapter.analyze({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png", signal: controller.signal });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort(new Error("user_cancelled"));
    await expect(pending).rejects.toThrow("user_cancelled");
    expect(providerSignal?.aborted).toBe(true);
  });

  it("uses a deterministic hard timeout for a stalled vision request", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    })));
    const adapter = new OpenAICompatibleImageVisionAdapter({ provider: "qwen", reasoningMode: "disabled", apiKey: "test-key", baseUrl: "https://qwen.test/v1", model: "qwen-vision-test" }, 30);
    await expect(adapter.analyze({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" })).rejects.toThrow("VISION_TIMEOUT");
  });

  it("preserves user cancellation when it races with the vision timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    })));
    const controller = new AbortController();
    const adapter = new OpenAICompatibleImageVisionAdapter({ provider: "qwen", reasoningMode: "disabled", apiKey: "test-key", baseUrl: "https://qwen.test/v1", model: "qwen-vision-test" }, 500);
    const pending = adapter.analyze({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png", signal: controller.signal });
    setTimeout(() => controller.abort(new Error("external cancellation")), 10);
    await expect(pending).rejects.toThrow("external cancellation");
  });
});
