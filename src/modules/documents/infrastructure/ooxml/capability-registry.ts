import type { DocumentNodeKind, NodeCapability } from "../../domain/types";

export type NodeCapabilityContext = {
  textBox?: boolean;
  crossRun?: boolean;
  containsNestedTable?: boolean;
  sharedMedia?: boolean;
};

/**
 * Infrastructure capability registry. It produces semantic operation
 * capabilities without exposing parser/OOXML types to the Agent layer.
 */
export function capabilitiesFor(kind: DocumentNodeKind, context: NodeCapabilityContext = {}): readonly NodeCapability[] {
  if (kind === "paragraph" && context.textBox) return [
    { operation: "read", state: "supported" },
    { operation: "replace-text", state: "guarded", reasonCode: "TEXTBOX_MUTATION_UNSUPPORTED", reason: "Text box representations require a coherence-safe feature adapter before writing." },
  ];
  if (kind === "paragraph" && context.crossRun) return [
    { operation: "read", state: "supported" },
    { operation: "replace-text", state: "guarded", reasonCode: "UNSAFE_CROSS_RUN_EDIT", reason: "Use an explicit inherit-start format policy before replacing text across formatting runs." },
  ];
  if (kind === "table-cell" && context.containsNestedTable) return [
    { operation: "read", state: "supported" },
    { operation: "set-cell-text", state: "guarded", reasonCode: "NESTED_TABLE_CONTAINER_UNSUPPORTED", reason: "Address an inner cell instead of replacing the nested-table container." },
  ];
  if (kind === "image" && context.sharedMedia) return [
    { operation: "read", state: "supported" },
    { operation: "replace-image", state: "guarded", reasonCode: "SHARED_MEDIA_PART_UNSUPPORTED", reason: "Replacing this part would change multiple drawings." },
  ];
  return kind === "paragraph"
    ? [{ operation: "read", state: "supported" }, { operation: "replace-text", state: "supported" }]
    : kind === "table-cell"
      ? [{ operation: "read", state: "supported" }, { operation: "set-cell-text", state: "supported" }]
      : [{ operation: "read", state: "supported" }, { operation: "replace-image", state: "supported" }];
}
