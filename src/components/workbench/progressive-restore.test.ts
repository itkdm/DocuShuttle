import { describe, expect, it } from "vitest";

import { startProgressiveProjection } from "./progressive-restore";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("progressive task restore", () => {
  it("commits fast conversation while the document remains pending", async () => {
    const conversation = deferred<string[]>();
    const document = deferred<string>();
    const committed: string[] = [];
    const current = true;
    startProgressiveProjection({ load: () => conversation.promise, onSuccess: () => committed.push("messages"), onSettled: () => committed.push("conversation-done") }, () => current);
    startProgressiveProjection({ load: () => document.promise, onSuccess: () => committed.push("document") }, () => current);
    conversation.resolve(["A"]);
    await flush();
    expect(committed).toEqual(["messages", "conversation-done"]);
    expect(document.promise).toBeInstanceOf(Promise);
  });

  it("does not let a stale task projection overwrite the next task", async () => {
    const taskA = deferred<string>();
    const taskB = deferred<string>();
    let value = "";
    let activeTask = "A";
    startProgressiveProjection({ load: () => taskA.promise, onSuccess: (next) => { value = next; } }, () => activeTask === "A");
    activeTask = "B";
    startProgressiveProjection({ load: () => taskB.promise, onSuccess: (next) => { value = next; } }, () => activeTask === "B");
    taskA.resolve("old");
    taskB.resolve("new");
    await flush();
    expect(value).toBe("new");
  });

  it("isolates projection failure and still settles its loading state", async () => {
    const failing = deferred<never>();
    const committed: string[] = [];
    startProgressiveProjection({ load: () => failing.promise, onSuccess: () => committed.push("unexpected"), onFailure: () => committed.push("failure"), onSettled: () => committed.push("done") }, () => true);
    failing.reject(new Error("inspection failed"));
    await flush();
    expect(committed).toEqual(["failure", "done"]);
  });
});
