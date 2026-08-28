export type ScrollMetrics = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

export function isAtBottom(element: ScrollMetrics, threshold = 48) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
}

export function scrollToBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTo">, behavior: ScrollBehavior = "auto") {
  element.scrollTo({ top: element.scrollHeight, behavior });
}
