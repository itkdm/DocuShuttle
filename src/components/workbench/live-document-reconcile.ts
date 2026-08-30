import type { AgentEvent } from "@/modules/agent";

export type DocumentReconcileRequest = {
  taskId: string;
  generation: number;
  projectionSequenceAtStart: number;
  targetRevision: string;
  toolName: string;
};

export type DocumentProjectionIdentity = Pick<DocumentReconcileRequest, "taskId" | "generation">;

export function isCurrentDocumentProjection(
  request: DocumentProjectionIdentity,
  current: DocumentProjectionIdentity | undefined,
): boolean {
  return Boolean(current && request.taskId === current.taskId && request.generation === current.generation);
}

export function shouldApplyDocumentReconcileRequest(
  request: Pick<DocumentReconcileRequest, "targetRevision">,
  latestRequestedTarget: string | undefined,
): boolean {
  return !latestRequestedTarget || request.targetRevision === latestRequestedTarget;
}

export function isDocumentProjectionSequenceCurrent(
  requestSequence: number,
  currentSequence: number,
): boolean {
  return requestSequence === currentSequence;
}

const DOCUMENT_MUTATION_TOOLS = new Set([
  "apply_text_change",
  "apply_text_changes",
  "replace_document_image",
]);

export function documentMutationRevisionFromEvent(event: AgentEvent): string | undefined {
  if (event.type !== "tool.completed" || !DOCUMENT_MUTATION_TOOLS.has(event.name)) return undefined;
  if (!event.output || typeof event.output !== "object") return undefined;
  const revision = (event.output as { revision?: unknown }).revision;
  return typeof revision === "string" ? revision : undefined;
}

export function createLatestDocumentReconcileScheduler(
  reconcile: (request: DocumentReconcileRequest) => Promise<void>,
) {
  let pendingRequest: DocumentReconcileRequest | undefined;
  let active: Promise<void> | undefined;
  let activeRequest: DocumentReconcileRequest | undefined;

  const drain = async () => {
    let lastError: unknown;
    while (pendingRequest) {
      const request = pendingRequest;
      pendingRequest = undefined;
      activeRequest = request;
      try {
        await reconcile(request);
        lastError = undefined;
      } catch (error) {
        lastError = error;
      } finally {
        activeRequest = undefined;
      }
    }
    if (lastError) throw lastError;
  };

  return {
    request(request: DocumentReconcileRequest) {
      const sameActiveRequest = activeRequest
        && activeRequest.taskId === request.taskId
        && activeRequest.generation === request.generation
        && activeRequest.targetRevision === request.targetRevision;
      if (!sameActiveRequest) pendingRequest = request;
      if (!active) active = drain().finally(() => { active = undefined; });
      return active;
    },
    waitForIdle() {
      return active ?? Promise.resolve();
    },
  };
}
