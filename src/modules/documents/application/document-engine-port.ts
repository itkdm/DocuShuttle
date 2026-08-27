import type {
  DocumentInspection,
  MutationPlan,
  MutationRequest,
  MutationResult,
} from "../domain/types";

/** Provider-neutral boundary used by document application use cases. */
export interface DocumentEnginePort {
  /** Inspection returns a persisted logical node map in `manifest.nodes`. */
  inspect(bytes: Uint8Array): Promise<DocumentInspection>;
  mutate(bytes: Uint8Array, request: MutationRequest): Promise<MutationResult>;
  validate(bytes: Uint8Array): Promise<DocumentInspection>;
  /** Optional dry-run boundary; implementations must not write package bytes. */
  planMutation?(bytes: Uint8Array, request: MutationRequest): Promise<MutationPlan>;
}
