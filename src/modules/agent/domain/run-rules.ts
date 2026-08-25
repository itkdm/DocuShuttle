import {
  DecisionFrozenError,
  InvalidRunOperationError,
  StaleDocumentRevisionError,
} from "./errors";
import type {
  AgentRun,
  AgentRunStatus,
  DecisionChoice,
  HitlDecision,
  Proposal,
  ReviewChoice,
  ReviewDecision,
  RunFailure,
} from "./model";
import { assertTransition, isTerminalStatus } from "./state-machine";

function withStatus(run: AgentRun, status: AgentRunStatus, now: string): AgentRun {
  assertTransition(run.status, status);
  return { ...run, status, updatedAt: now };
}

export function transitionRun(run: AgentRun, status: AgentRunStatus, now: string): AgentRun {
  return withStatus(run, status, now);
}

export function attachProposal(run: AgentRun, proposal: Proposal, now: string): AgentRun {
  if (run.status !== "analyzing") {
    throw new InvalidRunOperationError(
      "PROPOSAL_NOT_EXPECTED",
      `A proposal cannot be attached while the run is ${run.status}.`,
    );
  }
  if (proposal.runId !== run.id || proposal.baseRevision !== run.baseRevision) {
    throw new InvalidRunOperationError("INVALID_PROPOSAL", "Proposal identity or base revision is invalid.");
  }
  return withStatus({ ...run, proposal }, "awaiting_scope_confirmation", now);
}

export interface RecordDecisionInput {
  readonly id: string;
  readonly choice: DecisionChoice;
  readonly decidedBy: string;
  readonly currentRevision: string;
  readonly now: string;
}

export function recordScopeDecision(run: AgentRun, input: RecordDecisionInput): AgentRun {
  if (run.decision) {
    throw new DecisionFrozenError(run.decision.proposalId);
  }
  if (run.status !== "awaiting_scope_confirmation" || !run.proposal) {
    throw new InvalidRunOperationError(
      "DECISION_NOT_EXPECTED",
      `A scope decision cannot be recorded while the run is ${run.status}.`,
    );
  }
  if (run.proposal.baseRevision !== input.currentRevision) {
    throw new StaleDocumentRevisionError(run.proposal.baseRevision, input.currentRevision);
  }

  const decision: HitlDecision = Object.freeze({
    id: input.id,
    proposalId: run.proposal.id,
    runId: run.id,
    baseRevision: run.proposal.baseRevision,
    choice: input.choice,
    decidedBy: input.decidedBy,
    decidedAt: input.now,
    frozen: true,
  });

  if (input.choice === "rejected") {
    return withStatus({ ...run, decision }, "cancelled", input.now);
  }
  return withStatus({ ...run, decision }, "generating", input.now);
}

export function assertWritableRevision(run: AgentRun, currentRevision: string): void {
  const expected = run.decision?.baseRevision ?? run.baseRevision;
  if (expected !== currentRevision) {
    throw new StaleDocumentRevisionError(expected, currentRevision);
  }
}

export function rebaseRunForAnalysis(
  run: AgentRun,
  baseRevision: string,
  now: string,
): AgentRun {
  assertTransition(run.status, "analyzing");
  const cycle = run.cycle + 1;
  return {
    ...run,
    baseRevision,
    cycle,
    status: "analyzing",
    steps: run.steps.map((step, index) => ({
      id: step.id,
      kind: step.kind,
      status: "pending" as const,
      attempts: 0,
      idempotencyKey: `${run.id}:${cycle}:${index}:${step.kind}`,
    })),
    checkpoint: { cursor: 0, savedAt: now },
    proposal: undefined,
    decision: undefined,
    reviewDecision: undefined,
    workingRevision: undefined,
    failure: undefined,
    updatedAt: now,
  };
}

export interface RecordReviewDecisionInput {
  readonly id: string;
  readonly choice: ReviewChoice;
  readonly decidedBy: string;
  readonly reviewedRevision: string;
  readonly currentRevision: string;
  readonly now: string;
}

export function recordReviewDecision(
  run: AgentRun,
  input: RecordReviewDecisionInput,
): AgentRun {
  if (run.reviewDecision) {
    throw new DecisionFrozenError(run.reviewDecision.id);
  }
  if (run.status !== "awaiting_review" || !run.workingRevision) {
    throw new InvalidRunOperationError(
      "REVIEW_NOT_EXPECTED",
      `Review cannot be completed while the run is ${run.status}.`,
    );
  }
  if (
    input.reviewedRevision !== run.workingRevision ||
    input.currentRevision !== run.workingRevision
  ) {
    throw new StaleDocumentRevisionError(run.workingRevision, input.currentRevision);
  }
  const reviewDecision: ReviewDecision = Object.freeze({
    id: input.id,
    runId: run.id,
    reviewedRevision: input.reviewedRevision,
    choice: input.choice,
    decidedBy: input.decidedBy,
    decidedAt: input.now,
    frozen: true,
  });
  return withStatus(
    { ...run, reviewDecision },
    input.choice === "approved" ? "completed" : "cancelled",
    input.now,
  );
}

export function failRun(run: AgentRun, failure: Omit<RunFailure, "failedFrom">, now: string): AgentRun {
  if (isTerminalStatus(run.status)) {
    throw new InvalidRunOperationError("TERMINAL_RUN", `A ${run.status} run cannot fail.`);
  }
  const failedFrom = run.status;
  return withStatus({ ...run, failure: { ...failure, failedFrom } }, "failed", now);
}

export function retryRun(run: AgentRun, now: string): AgentRun {
  if (run.status !== "failed" || !run.failure) {
    throw new InvalidRunOperationError("RUN_NOT_RETRYABLE", "Only a failed run can be retried.");
  }
  if (!run.failure.retryable) {
    throw new InvalidRunOperationError("FAILURE_NOT_RETRYABLE", "The recorded failure is not retryable.");
  }

  const failedStepIndex = run.steps.findIndex((step) => step.status === "failed");
  const steps = failedStepIndex < 0
    ? run.steps
    : run.steps.map((step, index) =>
        index === failedStepIndex ? { ...step, status: "pending" as const, error: undefined } : step,
      );
  return withStatus({ ...run, steps, failure: undefined }, run.failure.failedFrom, now);
}

export function cancelRun(run: AgentRun, now: string): AgentRun {
  if (isTerminalStatus(run.status)) {
    throw new InvalidRunOperationError("TERMINAL_RUN", `A ${run.status} run cannot be cancelled.`);
  }
  return withStatus(run, "cancelled", now);
}
