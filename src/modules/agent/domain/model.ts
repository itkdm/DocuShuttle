export type AgentRunStatus =
  | "queued"
  | "analyzing"
  | "awaiting_scope_confirmation"
  | "generating"
  | "applying"
  | "validating"
  | "awaiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export type ActiveRunStatus = Extract<
  AgentRunStatus,
  "analyzing" | "generating" | "applying" | "validating"
>;

export type AgentStepKind = "analyze" | "generate" | "apply" | "validate";
export type AgentStepStatus = "pending" | "running" | "completed" | "failed";

export interface AgentStep {
  readonly id: string;
  readonly kind: AgentStepKind;
  readonly status: AgentStepStatus;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly inputRef?: string;
  readonly outputRef?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: RunFailure;
}

export interface RunCheckpoint {
  readonly cursor: number;
  readonly lastCompletedStepId?: string;
  readonly savedAt: string;
}

export interface SideEffectReceipt {
  readonly idempotencyKey: string;
  readonly stepId: string;
  readonly effect: AgentStepKind;
  readonly outputRef: string;
  readonly committedAt: string;
  readonly providerReceiptRef?: string;
  /** Analysis receipts retain the proposal so a checkpoint can be reconstructed. */
  readonly proposal?: Proposal;
  /** Apply receipts retain the immutable derived artifact revision for CAS recovery. */
  readonly derivedRevision?: string;
}

export type ProposalRisk = "low" | "high";

export interface Proposal {
  readonly id: string;
  readonly runId: string;
  readonly baseRevision: string;
  readonly summary: string;
  readonly risk: ProposalRisk;
  readonly createdAt: string;
}

export interface ProposalDraft {
  readonly id: string;
  readonly baseRevision: string;
  readonly summary: string;
  readonly risk: ProposalRisk;
}

export type DecisionChoice = "approved" | "rejected";

export interface HitlDecision {
  readonly id: string;
  readonly proposalId: string;
  readonly runId: string;
  readonly baseRevision: string;
  readonly choice: DecisionChoice;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly frozen: true;
}

export type ReviewChoice = "approved" | "rejected";

export interface ReviewDecision {
  readonly id: string;
  readonly runId: string;
  readonly reviewedRevision: string;
  readonly choice: ReviewChoice;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly frozen: true;
}

export type AgentCommandKind = "scope-decision" | "cancel" | "retry" | "review-decision";

export interface AgentCommandRecord {
  readonly id: string;
  readonly kind: AgentCommandKind;
  readonly fingerprint: string;
  readonly resultingStatus: AgentRunStatus;
  readonly recordedAt: string;
}

export interface RunFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly failedFrom: AgentRunStatus;
  readonly diagnostics?: Readonly<Record<string, string>>;
}

export interface AgentRun {
  readonly id: string;
  readonly documentId: string;
  readonly baseRevision: string;
  readonly cycle: number;
  readonly status: AgentRunStatus;
  readonly version: number;
  readonly eventCursor: number;
  readonly steps: readonly AgentStep[];
  readonly checkpoint: RunCheckpoint;
  readonly receipts: readonly SideEffectReceipt[];
  readonly proposal?: Proposal;
  readonly decision?: HitlDecision;
  readonly reviewDecision?: ReviewDecision;
  readonly workingRevision?: string;
  readonly commands: readonly AgentCommandRecord[];
  readonly failure?: RunFailure;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAgentRunInput {
  readonly id: string;
  readonly documentId: string;
  readonly baseRevision: string;
  readonly now: string;
}

export function createAgentRun(input: CreateAgentRunInput): AgentRun {
  const kinds: readonly AgentStepKind[] = ["analyze", "generate", "apply", "validate"];

  return {
    id: input.id,
    documentId: input.documentId,
    baseRevision: input.baseRevision,
    cycle: 0,
    status: "queued",
    version: 0,
    eventCursor: 0,
    steps: kinds.map((kind, index) => ({
      id: `${input.id}:${kind}`,
      kind,
      status: "pending",
      attempts: 0,
      idempotencyKey: `${input.id}:${index}:${kind}`,
    })),
    checkpoint: { cursor: 0, savedAt: input.now },
    receipts: [],
    commands: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}
