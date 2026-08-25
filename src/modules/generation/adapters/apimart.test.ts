import { describe, expect, it, vi } from "vitest";
import { APIMartImageGenerationAdapter } from "./apimart";

describe("APIMartImageGenerationAdapter", () => {
  it("submits and polls the asynchronous GPT Image 2 API", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ status: "submitted", task_id: "task-1" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "task-1", status: "processing" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "task-1", status: "completed", result: { images: [{ url: ["https://cdn.example/duck.png"] }] } } }), { status: 200 }));
    const adapter = new APIMartImageGenerationAdapter({ apiKey: "secret-test-key", baseUrl: "https://api.apimart.test/", model: "gpt-image-2", fetch: fetchMock, delay: vi.fn().mockResolvedValue(undefined) });
    const images = await adapter.generate({ prompt: "A technical diagram", size: "1536x1024", quality: "high", count: 1 });

    expect(images).toEqual([{ mimeType: "image/png", remoteUrl: "https://cdn.example/duck.png", providerRequestId: "task-1" }]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ size: "3:2", resolution: "2k" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("v1/tasks/task-1");
    expect(JSON.stringify(images)).not.toContain("secret-test-key");
  });

  it("marks throttling as retryable", async () => {
    const adapter = new APIMartImageGenerationAdapter({ apiKey: "test", baseUrl: "https://example.test/", model: "gpt-image-2", fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429 })) });
    await expect(adapter.generate({ prompt: "x", size: "1024x1024", quality: "standard", count: 1 })).rejects.toMatchObject({ provider: "apimart", retryable: true, status: 429 });
  });

  it("times out a task", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ task_id: "task-timeout" }] }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ data: { id: "task-timeout", status: "processing" } }), { status: 200 }));
    const adapter = new APIMartImageGenerationAdapter({ apiKey: "test", baseUrl: "https://example.test/", model: "gpt-image-2", fetch: fetchMock, maxPolls: 2, delay: vi.fn().mockResolvedValue(undefined) });
    await expect(adapter.generate({ prompt: "x", size: "1024x1024", quality: "standard", count: 1 })).rejects.toMatchObject({ retryable: true, status: 408 });
  });
});
