import { afterEach, describe, expect, it, vi } from "vitest";

import { recoverBrowserAgentLoop } from "./browser-runtime";

const checkpoint = (status: "running" | "completed") => ({
  status,
  iterations: 1,
  messages: [],
  permissionMode: "default" as const,
});

afterEach(() => vi.restoreAllMocks());

describe("browser Agent recovery", () => {
  it("reconciles a terminal checkpoint from replay without opening a recovery stream", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/loop?after=0&limit=500");
      expect(init).toBeUndefined();
      return new Response(JSON.stringify({ checkpoint: checkpoint("completed"), events: [], nextSequence: 12, hasMore: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const recovered = await recoverBrowserAgentLoop("run-terminal", () => {});
    expect(recovered.checkpoint.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("continues the same run without resubmitting a prompt", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/loop?after=0&limit=500")) return new Response(JSON.stringify({ checkpoint: checkpoint("running"), events: [], nextSequence: 3, hasMore: false }), { status: 200 });
      expect(url).toBe("/api/agent/runs/run-running/loop/recover");
      expect(init?.method).toBe("PUT");
      expect(init).not.toHaveProperty("body");
      return new Response(`event: result\ndata: ${JSON.stringify({ checkpoint: checkpoint("completed"), events: [] })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const recovered = await recoverBrowserAgentLoop("run-running", () => {});
    expect(recovered.checkpoint.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
