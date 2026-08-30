import { describe, expect, it, vi } from "vitest";
import { createAgentEvent } from "@/modules/agent";
import { createLatestDocumentReconcileScheduler, documentMutationRevisionFromEvent } from "./live-document-reconcile";

describe("live document reconcile", () => {
  it("recognizes only completed document mutations with a revision", () => {
    expect(documentMutationRevisionFromEvent(createAgentEvent("run-1", {
      type: "tool.completed", callId: "call-1", name: "apply_text_change", output: { revision: "r11" },
    }))).toBe("r11");
    expect(documentMutationRevisionFromEvent(createAgentEvent("run-1", {
      type: "tool.completed", callId: "call-2", name: "inspect_document", output: { revision: "r12" },
    }))).toBeUndefined();
    expect(documentMutationRevisionFromEvent(createAgentEvent("run-1", {
      type: "tool.started", callId: "call-3", name: "apply_text_change", input: {},
    }))).toBeUndefined();
    expect(documentMutationRevisionFromEvent(createAgentEvent("run-1", {
      type: "tool.completed", callId: "call-4", name: "apply_text_changes", output: { revision: 12 },
    }))).toBeUndefined();
    expect(documentMutationRevisionFromEvent(createAgentEvent("run-1", {
      type: "client_tool.resolved", interactionId: "interaction-1", callId: "call-5", name: "capture_document_view",
      assetId: "asset-1", mimeType: "image/png", sha256: "hash", width: 100, height: 100, revision: "r13",
    }))).toBeUndefined();
    expect(documentMutationRevisionFromEvent(createAgentEvent("run-1", {
      type: "client_tool.resolved", interactionId: "interaction-2", callId: "call-6", name: "scroll_document_view",
      revision: "r14", beforeScrollTop: 0, scrollTop: 100, maxScrollTop: 500, viewportHeight: 800, moved: true, atTop: false, atBottom: false,
    }))).toBeUndefined();
  });

  it("coalesces mutations while the latest reconcile is in flight", async () => {
    const gates = [deferred<void>(), deferred<void>()];
    const reconciled: string[] = [];
    const reconcile = vi.fn(async (revision: string) => {
      reconciled.push(revision);
      await gates[reconciled.length - 1]?.promise;
    });
    const scheduler = createLatestDocumentReconcileScheduler(reconcile);

    const first = scheduler.request("r11");
    await Promise.resolve();
    scheduler.request("r12");
    scheduler.request("r13");
    expect(reconcile).toHaveBeenCalledTimes(1);
    gates[0].resolve();
    await vi.waitFor(() => expect(reconciled).toEqual(["r11", "r13"]));
    gates[1].resolve();
    await first;
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("does not permanently block later requests after a failed reconcile", async () => {
    let attempts = 0;
    const reconcile = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
    });
    const scheduler = createLatestDocumentReconcileScheduler(reconcile);

    await expect(scheduler.request("r11")).rejects.toThrow("temporary failure");
    await expect(scheduler.request("r12")).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}
