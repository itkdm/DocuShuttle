import type { DocumentDiagnostic, DocumentMutation, DocumentNodeKind, NativeIdentity, NodeCapability } from "../../domain/types";
import type { NodeCapabilityContext } from "./capability-registry";

export interface FeatureAdapterContext extends NodeCapabilityContext {
  kind: DocumentNodeKind;
  sourceXml?: string;
}

/** Infrastructure-only extension point for OOXML feature recognition and capability resolution. */
export interface OoxmlFeatureAdapter {
  readonly featureId: string;
  recognize(context: FeatureAdapterContext): boolean;
  resolveCapabilities(context: FeatureAdapterContext): readonly NodeCapability[];
  /** Optional lifecycle hooks; feature adapters remain isolated from Agent runtime. */
  buildSemanticNodes?(context: FeatureAdapterContext): readonly unknown[];
  planMutation?(context: FeatureAdapterContext, operation: DocumentMutation): readonly unknown[];
  validateResult?(context: FeatureAdapterContext): readonly DocumentDiagnostic[];
  identityHints?(context: FeatureAdapterContext): readonly NativeIdentity[];
}

export class FeatureAdapterRegistry {
  private readonly adapters: OoxmlFeatureAdapter[] = [];

  register(adapter: OoxmlFeatureAdapter): this {
    if (this.adapters.some((candidate) => candidate.featureId === adapter.featureId)) throw new Error(`FEATURE_ADAPTER_DUPLICATE:${adapter.featureId}`);
    this.adapters.push(adapter);
    return this;
  }

  resolveCapabilities(context: FeatureAdapterContext): readonly NodeCapability[] | undefined {
    return this.adapters.find((adapter) => adapter.recognize(context))?.resolveCapabilities(context);
  }

  matching(context: FeatureAdapterContext): readonly OoxmlFeatureAdapter[] {
    return this.adapters.filter((adapter) => adapter.recognize(context));
  }

  list(): readonly string[] { return this.adapters.map((adapter) => adapter.featureId); }
}

export function createDefaultFeatureAdapterRegistry(): FeatureAdapterRegistry {
  return new FeatureAdapterRegistry()
    .register({ featureId: "textbox", recognize: (context) => context.kind === "paragraph" && Boolean(context.textBox), resolveCapabilities: () => [{ operation: "read", state: "supported" }, { operation: "replace-text", state: "guarded", reasonCode: "TEXTBOX_MUTATION_UNSUPPORTED", reason: "Text box representations require a coherence-safe feature adapter before writing." }] })
    .register({ featureId: "cross-run-text", recognize: (context) => context.kind === "paragraph" && Boolean(context.crossRun), resolveCapabilities: () => [{ operation: "read", state: "supported" }, { operation: "replace-text", state: "guarded", reasonCode: "UNSAFE_CROSS_RUN_EDIT", reason: "Use an explicit inherit-start format policy before replacing text across formatting runs." }] })
    .register({ featureId: "nested-table-container", recognize: (context) => context.kind === "table-cell" && Boolean(context.containsNestedTable), resolveCapabilities: () => [{ operation: "read", state: "supported" }, { operation: "set-cell-text", state: "guarded", reasonCode: "NESTED_TABLE_CONTAINER_UNSUPPORTED", reason: "Address an inner cell instead of replacing the nested-table container." }] })
    .register({ featureId: "shared-media", recognize: (context) => context.kind === "image" && Boolean(context.sharedMedia), resolveCapabilities: () => [{ operation: "read", state: "supported" }, { operation: "replace-image", state: "guarded", reasonCode: "SHARED_MEDIA_PART_UNSUPPORTED", reason: "Replacing this part would change multiple drawings." }] });
}
