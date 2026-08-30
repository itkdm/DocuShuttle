import { describe, expect, it, vi } from "vitest";
import { createAgentEvent } from "@/modules/agent";
import { createLatestDocumentReconcileScheduler, documentMutationRevisionFromEvent, isCurrentDocumentProjection, shouldApplyDocumentReconcileRequest, type DocumentReconcileRequest } from "./live-document-reconcile";

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
    const reconcile = vi.fn(async (request: DocumentReconcileRequest) => {
      reconciled.push(request.targetRevision);
      await gates[reconciled.length - 1]?.promise;
    });
    const scheduler = createLatestDocumentReconcileScheduler(reconcile);
    const request = (targetRevision: string): DocumentReconcileRequest => ({ taskId: "task-a", generation: 1, targetRevision, toolName: "apply_text_change" });

    const first = scheduler.request(request("r11"));
    await Promise.resolve();
    scheduler.request(request("r12"));
    scheduler.request(request("r13"));
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
    const request = (targetRevision: string): DocumentReconcileRequest => ({ taskId: "task-a", generation: 1, targetRevision, toolName: "apply_text_change" });

    await expect(scheduler.request(request("r11"))).rejects.toThrow("temporary failure");
    await expect(scheduler.request(request("r12"))).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("rejects a response after the workspace switches tasks", () => {
    expect(isCurrentDocumentProjection({ taskId: "task-a", generation: 1 }, { taskId: "task-b", generation: 2 })).toBe(false);
  });

  it("allows recovery to apply the authoritative revision when its trigger is older", () => {
    expect(shouldApplyDocumentReconcileRequest({ targetRevision: "r11" }, "r11")).toBe(true);
  });

  it("skips a request superseded by a newer mutation target", () => {
    expect(shouldApplyDocumentReconcileRequest({ targetRevision: "r11" }, "r13")).toBe(false);
  });

  it("coalesces task-scoped requests without projecting the old task into the new one", async () => {
    const gate = deferred<void>();
    const reconciled: DocumentReconcileRequest[] = [];
    const reconcile = vi.fn(async (request: DocumentReconcileRequest) => {
      reconciled.push(request);
      await gate.promise;
    });
    const scheduler = createLatestDocumentReconcileScheduler(reconcile);
    const first = scheduler.request({ taskId: "task-a", generation: 1, targetRevision: "r11", toolName: "apply_text_change" });
    await Promise.resolve();
    scheduler.request({ taskId: "task-b", generation: 2, targetRevision: "r22", toolName: "apply_text_change" });
    gate.resolve();
    await first;
    expect(reconciled.map((item) => `${item.taskId}:${item.targetRevision}`)).toEqual(["task-a:r11", "task-b:r22"]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}
