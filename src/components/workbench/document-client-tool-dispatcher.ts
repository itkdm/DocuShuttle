import { captureDocumentViewInputSchema, scrollDocumentViewInputSchema } from "@/modules/agent/application/client-tools";
import type { AgentClientToolResult, AgentDocumentCaptureResult, AgentRuntimePendingInteraction } from "@/modules/agent/domain/model";
import { uploadBrowserDocumentPreview } from "@/modules/agent/browser-runtime";
import type { DocumentSurfacePort } from "@/modules/documents";

type PendingClientTool = Extract<AgentRuntimePendingInteraction, { type: "client_tool" }>;
type ClientToolIdentity = Pick<PendingClientTool, "interactionId" | "callId"> & { runId: string };

/** Browser-only execution boundary for durable document client tools. */
export function createDocumentClientToolDispatcher() {
  const results = new Map<string, AgentClientToolResult>();

  return {
    async execute(pending: PendingClientTool, surface: DocumentSurfacePort, taskId: string, runId: string): Promise<AgentClientToolResult> {
      const state = surface.getState();
      if (!state.ready || state.dirty || state.renderedRevision !== pending.expectedRevision) {
        throw new Error("DOCUMENT_VIEW_NOT_SYNCHRONIZED");
      }
      const identity: ClientToolIdentity = { runId, interactionId: pending.interactionId, callId: pending.callId };
      const key = `${identity.runId}:${identity.interactionId}:${identity.callId}`;
      const cached = results.get(key);
      if (pending.toolName === "scroll_document_view") {
        const input = scrollDocumentViewInputSchema.parse(pending.input);
        if (cached && "scrollTop" in cached) {
          await surface.scrollViewport(input, cached.scrollTop);
          return cached;
        }
        const result = await surface.scrollViewport(input);
        results.set(key, result);
        return result;
      }
      if (pending.toolName !== "capture_document_view") throw new Error("CLIENT_TOOL_INTERACTION_MISMATCH");
      if (cached) return cached;
      captureDocumentViewInputSchema.parse(pending.input);
      const capture = await surface.captureVisible();
      const asset: AgentDocumentCaptureResult = await uploadBrowserDocumentPreview(taskId, identity, capture);
      results.set(key, asset);
      return asset;
    },
  };
}
