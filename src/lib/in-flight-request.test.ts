import { describe, expect, it } from "vitest";

import { createInFlightRequestCache } from "./in-flight-request";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((res) => { resolve = res; });
  return { promise, resolve };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("in-flight request cache", () => {
  it("coalesces concurrent workspace requests for the same task", async () => {
    const cache = createInFlightRequestCache<string, string>();
    const pending = deferred<string>();
    let calls = 0;
    const loader = () => { calls += 1; return pending.promise; };

    const first = cache.load("task-a", loader);
    const second = cache.load("task-a", loader);
    pending.resolve("workspace-a");

    await expect(Promise.all([first, second])).resolves.toEqual(["workspace-a", "workspace-a"]);
    expect(calls).toBe(1);
  });

  it("coalesces conversation requests by task and cursor", async () => {
    const cache = createInFlightRequestCache<string, string>();
    const latest = deferred<string>();
    const earlier = deferred<string>();
    let calls = 0;
    const loader = (pending: ReturnType<typeof deferred<string>>) => () => { calls += 1; return pending.promise; };

    const first = cache.load("task-a:latest", loader(latest));
    const second = cache.load("task-a:latest", loader(latest));
    const differentCursor = cache.load("task-a:cursor-1", loader(earlier));
    latest.resolve("latest");
    earlier.resolve("earlier");

    await expect(Promise.all([first, second, differentCursor])).resolves.toEqual(["latest", "latest", "earlier"]);
    expect(calls).toBe(2);
  });

  it("keeps different workspace task ids independent", async () => {
    const cache = createInFlightRequestCache<string, string>();
    let calls = 0;
    const loader = async (taskId: string) => { calls += 1; return `workspace-${taskId}`; };

    await expect(Promise.all([
      cache.load("task-a", () => loader("a")),
      cache.load("task-b", () => loader("b")),
    ])).resolves.toEqual(["workspace-a", "workspace-b"]);
    expect(calls).toBe(2);
  });

  it("evicts a settled request so the next load is fresh", async () => {
    const cache = createInFlightRequestCache<string, number>();
    let calls = 0;
    const loader = async () => ++calls;

    await expect(cache.load("task-a", loader)).resolves.toBe(1);
    await flush();
    await expect(cache.load("task-a", loader)).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it("does not let an older cleanup remove a newer request", async () => {
    const cache = createInFlightRequestCache<string, string>();
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const firstRequest = cache.load("task-a", () => { calls += 1; return first.promise; });
    first.resolve("first");
    await flush();
    const secondRequest = cache.load("task-a", () => { calls += 1; return second.promise; });
    second.resolve("second");

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual(["first", "second"]);
    expect(calls).toBe(2);
  });

  it("lets a current consumer use the shared request after the first is stale", async () => {
    const cache = createInFlightRequestCache<string, string>();
    const pending = deferred<string>();
    let staleCommitted = "";
    let currentCommitted = "";
    const shared = cache.load("task-a", () => pending.promise);
    const replacement = cache.load("task-a", () => Promise.resolve("unexpected-new-request"));
    let stale = true;
    void shared.then((value) => { if (stale) staleCommitted = value; });
    void replacement.then((value) => { currentCommitted = value; });
    stale = false;
    pending.resolve("shared-result");
    const [staleResult, currentResult] = await Promise.all([shared, replacement]);
    currentCommitted = currentResult;

    expect(staleResult).toBe("shared-result");
    expect(staleCommitted).toBe("");
    expect(currentCommitted).toBe("shared-result");
  });
});
