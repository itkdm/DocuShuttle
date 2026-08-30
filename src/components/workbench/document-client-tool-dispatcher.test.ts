import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePendingInteraction } from "@/modules/agent/domain/model";
import type { DocumentSurfacePort } from "@/modules/documents";

const upload = vi.hoisted(() => vi.fn(async () => ({ assetId: "asset-1", mimeType: "image/png" as const, sha256: "a".repeat(64), width: 800, height: 600, revision: "rev-1" })));
vi.mock("@/modules/agent/browser-runtime", () => ({ uploadBrowserDocumentPreview: upload }));

import { createDocumentClientToolDispatcher } from "./document-client-tool-dispatcher";

function surface() {
  let scrollTop = 0;
  const scrollViewport = vi.fn(async (_command: unknown, target?: number) => {
    scrollTop = target ?? 800;
    return { revision: "rev-1", beforeScrollTop: 0, scrollTop, maxScrollTop: 2_000, viewportHeight: 1_000, moved: true, atTop: false, atBottom: false };
  });
  return { getState: () => ({ ready: true, dirty: false, renderedRevision: "rev-1" }), captureVisible: vi.fn(async () => ({ blob: new Blob(["png"]), mimeType: "image/png" as const, width: 800, height: 600 })), scrollViewport } as unknown as DocumentSurfacePort;
}

const pending = (input: unknown): Extract<AgentRuntimePendingInteraction, { type: "client_tool" }> => ({ interactionId: "interaction-1", type: "client_tool", callId: "call-1", toolName: "scroll_document_view", input, expectedRevision: "rev-1" });

describe("document client tool dispatcher", () => {
  it("does not double-scroll a relative call when the same client identity retries", async () => {
    const dispatcher = createDocumentClientToolDispatcher();
    const target = surface();
    const first = await dispatcher.execute(pending({ kind: "relative", direction: "down", amount: "viewport" }), target, "task-1", "run-1");
    const second = await dispatcher.execute(pending({ kind: "relative", direction: "down", amount: "viewport" }), target, "task-1", "run-1");
    expect(first).toEqual(second);
    expect(target.scrollViewport).toHaveBeenCalledTimes(2);
    expect(target.scrollViewport).toHaveBeenLastCalledWith({ kind: "relative", direction: "down", amount: "viewport" }, 800);
  });

  it("rejects a surface whose rendered revision differs from the pending interaction", async () => {
    const target = surface();
    target.getState = () => ({ ready: true, dirty: false, renderedRevision: "rev-2" });
    await expect(createDocumentClientToolDispatcher().execute(pending({ kind: "edge", target: "bottom" }), target, "task-1", "run-1")).rejects.toThrow("DOCUMENT_VIEW_NOT_SYNCHRONIZED");
  });
});
