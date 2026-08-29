import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeReplayEvents, recoverBrowserAgentLoop, runBrowserAgentLoopStream } from "./browser-runtime";

const checkpoint = (status: "running" | "completed") => ({
  status,
  iterations: 1,
  messages: [],
  permissionMode: "default" as const,
});

afterEach(() => vi.restoreAllMocks());

describe("browser Agent recovery", () => {
  it("acknowledges same-run submission only after the first streamed durable event", async () => {
    const fetchMock = vi.fn(async () => new Response(
      `event: event\ndata: ${JSON.stringify({ eventId: "started", runId: "run-user", timestamp: "2026-08-28T00:00:00.000Z", type: "model.started", text: "request" })}\n\nevent: result\ndata: ${JSON.stringify({ checkpoint: checkpoint("completed"), events: [] })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    let accepted = false;
    const stream = runBrowserAgentLoopStream("run-user", "回答", "default", () => {}, undefined, "message-1", "interaction-1", [], () => { accepted = true; });
    expect(accepted).toBe(false);
    const result = await stream;
    expect(accepted).toBe(true);
    expect(result.checkpoint.status).toBe("completed");
  });

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

  it("replays every durable page before recovering the same run", async () => {
    let replayCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/loop?")) {
        replayCalls += 1;
        const after = new URL(url, "http://localhost").searchParams.get("after");
        if (after === "0") {
          return new Response(JSON.stringify({ checkpoint: checkpoint("running"), events: [{ eventId: "e1", runId: "run-pages", timestamp: "2026-08-28T00:00:00.000Z", sequence: 1, type: "model.started", text: "request" }], nextSequence: 1, hasMore: true }), { status: 200 });
        }
        expect(after).toBe("1");
        return new Response(JSON.stringify({ checkpoint: checkpoint("running"), events: [{ eventId: "e2", runId: "run-pages", timestamp: "2026-08-28T00:00:01.000Z", sequence: 2, type: "model.completed", durationMs: 1 }], nextSequence: 2, hasMore: false }), { status: 200 });
      }
      expect(url).toBe("/api/agent/runs/run-pages/loop/recover");
      expect(init?.method).toBe("PUT");
      return new Response(`event: result\ndata: ${JSON.stringify({ checkpoint: checkpoint("completed"), events: [] })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const events: string[] = [];
    const recovered = await recoverBrowserAgentLoop("run-pages", (event) => events.push(event.eventId));
    expect(replayCalls).toBe(2);
    expect(events).toEqual(["e1", "e2"]);
    expect(recovered.checkpoint.status).toBe("completed");
  });

  it("keeps replay strictly durable and excludes live-only model deltas", () => {
    const events = normalizeReplayEvents([
      { eventId: "delta", runId: "run-1", timestamp: "2026-08-28T00:00:00.000Z", type: "model.delta", text: "live" },
      { eventId: "started", runId: "run-1", timestamp: "2026-08-28T00:00:01.000Z", sequence: 1, type: "model.started", text: "request" },
    ]);
    expect(events.map((event) => event.eventId)).toEqual(["started"]);
  });
});
