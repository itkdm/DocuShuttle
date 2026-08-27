import type { DocumentNodeKind, NodeCapability } from "../../domain/types";
import { createDefaultFeatureAdapterRegistry } from "./feature-adapter-registry";

export type NodeCapabilityContext = {
  textBox?: boolean;
  crossRun?: boolean;
  contentControl?: boolean;
  field?: boolean;
  revision?: boolean;
  containsNestedTable?: boolean;
  sharedMedia?: boolean;
};

export const featureAdapterRegistry = createDefaultFeatureAdapterRegistry();

/**
 * Infrastructure capability registry. It produces semantic operation
 * capabilities without exposing parser/OOXML types to the Agent layer.
 */
export function capabilitiesFor(kind: DocumentNodeKind, context: NodeCapabilityContext = {}): readonly NodeCapability[] {
  const resolved = featureAdapterRegistry.resolveCapabilities({ kind, ...context });
  if (resolved) return resolved;
  return kind === "paragraph"
    ? [{ operation: "read", state: "supported" }, { operation: "replace-text", state: "supported" }]
    : kind === "table-cell"
      ? [{ operation: "read", state: "supported" }, { operation: "set-cell-text", state: "supported" }]
      : [{ operation: "read", state: "supported" }, { operation: "replace-image", state: "supported" }];
}
