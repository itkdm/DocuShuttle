import type { AgentEvent } from "@/modules/agent";

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
  reconcile: (targetRevision: string) => Promise<void>,
) {
  let pendingRevision: string | undefined;
  let active: Promise<void> | undefined;
  let activeRevision: string | undefined;

  const drain = async () => {
    let lastError: unknown;
    while (pendingRevision) {
      const targetRevision = pendingRevision;
      pendingRevision = undefined;
      activeRevision = targetRevision;
      try {
        await reconcile(targetRevision);
        lastError = undefined;
      } catch (error) {
        lastError = error;
      } finally {
        activeRevision = undefined;
      }
    }
    if (lastError) throw lastError;
  };

  return {
    request(targetRevision: string) {
      if (activeRevision !== targetRevision) pendingRevision = targetRevision;
      if (!active) active = drain().finally(() => { active = undefined; });
      return active;
    },
  };
}
