import type {
  AgentRunStatus,
  AgentStepKind,
  DecisionChoice,
  ProposalRisk,
  ReviewChoice,
} from "../domain/model";

interface EventEnvelope<TType extends string, TData> {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: TType;
  readonly data: TData;
}

export type AgentRunEvent =
  | EventEnvelope<"run.status_changed", { from: AgentRunStatus; to: AgentRunStatus }>
  | EventEnvelope<"step.started", { stepId: string; kind: AgentStepKind; attempt: number }>
  | EventEnvelope<"step.completed", { stepId: string; kind: AgentStepKind; outputRef: string }>
  | EventEnvelope<"step.receipt_reused", { stepId: string; idempotencyKey: string }>
  | EventEnvelope<"step.failed", { stepId: string; code: string; retryable: boolean }>
  | EventEnvelope<
      "checkpoint.saved",
      { cursor: number; lastCompletedStepId?: string }
    >
  | EventEnvelope<
      "proposal.created",
      { proposalId: string; baseRevision: string; risk: ProposalRisk }
    >
  | EventEnvelope<
      "hitl.decision_frozen",
      { decisionId: string; proposalId: string; choice: DecisionChoice; decidedBy: string }
    >
  | EventEnvelope<"run.cancelled", { previousStatus: AgentRunStatus }>
  | EventEnvelope<"run.retried", { resumeStatus: AgentRunStatus }>
  | EventEnvelope<"step.cancelled_effect_reconciled", { stepId: string; idempotencyKey: string }>
  | EventEnvelope<
      "review.decision_frozen",
      { decisionId: string; reviewedRevision: string; choice: ReviewChoice; decidedBy: string }
    >
  | EventEnvelope<
      "run.revision_conflict",
      { expectedRevision: string; actualRevision: string }
    >;

export function createEvent<T extends AgentRunEvent["type"]>(
  type: T,
  envelope: Omit<Extract<AgentRunEvent, { type: T }>, "type">,
): Extract<AgentRunEvent, { type: T }> {
  return { ...envelope, type } as Extract<AgentRunEvent, { type: T }>;
}
