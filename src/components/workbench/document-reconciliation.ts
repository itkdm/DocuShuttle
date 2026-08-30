export function shouldReloadDocumentForRevision(
  currentRevision: string | undefined,
  nextRevision: string | undefined,
): boolean {
  return currentRevision !== nextRevision;
}
