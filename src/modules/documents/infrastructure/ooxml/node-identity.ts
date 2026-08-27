import type { DocumentNodeManifest, NodeRemap } from "../../domain/types";

function nativeKey(node: DocumentNodeManifest): string | undefined {
  return node.nativeIdentity ? `${node.kind}\u0000${node.nativeIdentity.scope ?? ""}\u0000${node.nativeIdentity.kind}\u0000${node.nativeIdentity.value}` : undefined;
}

/**
 * Computes a conservative sidecar remap between two manifests. It never
 * guesses when a fingerprint/native hint maps to more than one candidate.
 */
export function remapNodeIdentities(previous: readonly DocumentNodeManifest[], current: readonly DocumentNodeManifest[]): NodeRemap {
  const currentById = new Map(current.map((node) => [node.nodeId, node]));
  const currentByNative = new Map<string, DocumentNodeManifest[]>();
  const currentByFingerprint = new Map<string, DocumentNodeManifest[]>();
  for (const node of current) {
    const native = nativeKey(node);
    if (native) currentByNative.set(native, [...(currentByNative.get(native) ?? []), node]);
    const fingerprint = `${node.kind}\u0000${node.fingerprint}`;
    currentByFingerprint.set(fingerprint, [...(currentByFingerprint.get(fingerprint) ?? []), node]);
  }
  const matchedCurrent = new Set<string>();
  const matchedPrevious = new Set<string>();
  const retained: string[] = [];
  const moved: string[] = [];
  const changed: string[] = [];
  const ambiguous: string[] = [];
  for (const oldNode of previous) {
    let candidate = currentById.get(oldNode.nodeId);
    if (!candidate) {
      const native = nativeKey(oldNode);
      const nativeMatches = native ? currentByNative.get(native) ?? [] : [];
      if (nativeMatches.length === 1) candidate = nativeMatches[0];
      else if (nativeMatches.length > 1) { ambiguous.push(oldNode.nodeId); continue; }
    }
    if (!candidate) {
      const fingerprintMatches = currentByFingerprint.get(`${oldNode.kind}\u0000${oldNode.fingerprint}`) ?? [];
      if (fingerprintMatches.length === 1) candidate = fingerprintMatches[0];
      else if (fingerprintMatches.length > 1) { ambiguous.push(oldNode.nodeId); continue; }
    }
    if (!candidate || matchedCurrent.has(candidate.nodeId)) continue;
    matchedCurrent.add(candidate.nodeId);
    matchedPrevious.add(oldNode.nodeId);
    if (candidate.fingerprint !== oldNode.fingerprint) changed.push(oldNode.nodeId);
    else if (candidate.path !== oldNode.path || candidate.entry !== oldNode.entry) moved.push(oldNode.nodeId);
    else retained.push(oldNode.nodeId);
  }
  const inserted = current.filter((node) => !matchedCurrent.has(node.nodeId)).map((node) => node.nodeId);
  const deleted = previous.filter((node) => !matchedPrevious.has(node.nodeId) && !ambiguous.includes(node.nodeId)).map((node) => node.nodeId);
  return { retained, moved, changed, inserted, deleted, ambiguous };
}
