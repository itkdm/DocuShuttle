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
    const content = (request?.messages as Array<{ content: unknown }>)[0]?.content as Array<Record<string, unknown>>;
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: "data:image/png;base64,AQID" }) }),
    ]));
    expect(JSON.stringify(request)).not.toContain("objectKey");
  });
});
