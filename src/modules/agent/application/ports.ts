import type {
  AgentRun,
  AgentStep,
  ProposalDraft,
  SideEffectReceipt,
} from "../domain/model";
import type { AgentRunEvent } from "./events";

export interface AgentRunStore {
  load(runId: string): Promise<AgentRun | null>;
  save(run: AgentRun, expectedVersion: number, events: readonly AgentRunEvent[]): Promise<AgentRun>;
}

export interface StepExecutionContext {
  readonly run: AgentRun;
  readonly step: AgentStep;
  readonly idempotencyKey: string;
}

export interface StepExecutionResult {
  readonly outputRef: string;
  readonly providerReceiptRef?: string;
  readonly proposal?: ProposalDraft;
  /** Required for apply: revision of the validated immutable derived artifact. */
  readonly derivedRevision?: string;
}

export interface EffectReceiptStore {
  load(idempotencyKey: string): Promise<SideEffectReceipt | null>;
  /** Atomically inserts once and returns the existing receipt on an idempotent replay. */
  saveOnce(receipt: SideEffectReceipt): Promise<SideEffectReceipt>;
}

export interface CommitDerivedVersionInput {
  readonly runId: string;
  readonly expectedRunVersion: number;
  readonly documentId: string;
  readonly expectedRevision: string;
  readonly derivedRevision: string;
  readonly outputRef: string;
  readonly idempotencyKey: string;
}

export type CommitDerivedVersionResult =
  | { readonly kind: "committed"; readonly versionRef: string }
  | { readonly kind: "revision-conflict"; readonly actualRevision: string }
  | { readonly kind: "run-cancelled" };

export interface DocumentVersionCommitPort {
  /** Authoritative server-side revision; never substitute a client-supplied value. */
  getCurrentRevision(documentId: string): Promise<string>;
  /**
   * Must atomically CAS both current document revision and active run version/status.
   * Replaying the idempotency key returns the original committed result.
   */
  commitDerivedVersion(input: CommitDerivedVersionInput): Promise<CommitDerivedVersionResult>;
}

export interface CancelledEffectReconciler {
  /** Cleans temporary artifacts or records non-reversible provider usage. Must be idempotent. */
  reconcileCancelled(run: AgentRun, receipt: SideEffectReceipt): Promise<void>;
}

export interface AgentStepExecutor {
  /** Implementations must make this operation idempotent for the supplied key. */
  executeOnce(context: StepExecutionContext): Promise<StepExecutionResult>;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface PersistedStepResult {
  readonly run: AgentRun;
  readonly receipt: SideEffectReceipt;
}
