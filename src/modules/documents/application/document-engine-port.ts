import type {
  DocumentInspection,
  MutationRequest,
  MutationResult,
} from "../domain/types";

/** Provider-neutral boundary used by document application use cases. */
export interface DocumentEnginePort {
  /** Inspection returns a persisted logical node map in `manifest.nodes`. */
  inspect(bytes: Uint8Array): Promise<DocumentInspection>;
  mutate(bytes: Uint8Array, request: MutationRequest): Promise<MutationResult>;
  validate(bytes: Uint8Array): Promise<DocumentInspection>;
}
