import type { DocumentScrollCommand, DocumentScrollResult } from "@/modules/documents";
import { resolveDocumentViewport } from "./capture-document-viewport";

const EPSILON = 0.5;

const waitForLayout = async () => {
  if (typeof requestAnimationFrame === "function") {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  } else {
    await Promise.resolve();
    await Promise.resolve();
  }
};

export async function scrollDocumentViewport(root: HTMLElement, command: DocumentScrollCommand, revision: string, targetScrollTop?: number): Promise<DocumentScrollResult> {
  const viewport = resolveDocumentViewport(root);
  if (!viewport) throw new Error("DOCUMENT_VIEW_NOT_READY");
  const beforeScrollTop = viewport.scrollTop;
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const viewportHeight = viewport.clientHeight;
  const calculatedTarget = command.kind === "edge"
    ? command.target === "top" ? 0 : maxScrollTop
    : beforeScrollTop + (command.direction === "down" ? 1 : -1) * viewportHeight * (command.amount === "small" ? 0.35 : 0.8);
  const nextScrollTop = Math.min(maxScrollTop, Math.max(0, targetScrollTop ?? calculatedTarget));
  viewport.scrollTop = nextScrollTop;
  await waitForLayout();
  const scrollTop = viewport.scrollTop;
  return {
    revision,
    beforeScrollTop,
    scrollTop,
    maxScrollTop,
    viewportHeight,
    moved: Math.abs(scrollTop - beforeScrollTop) > EPSILON,
    atTop: scrollTop <= EPSILON,
    atBottom: scrollTop >= maxScrollTop - EPSILON,
  };
}
