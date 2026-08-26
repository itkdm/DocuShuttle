import {
  CommandConflictError,
  ConcurrentRunUpdateError,
  InvalidRunOperationError,
  RunNotFoundError,
  StaleDocumentRevisionError,
  StepExecutionError,
} from "../domain/errors";
import type {
  ActiveRunStatus,
  AgentCommandKind,
  AgentRun,
  AgentRunStatus,
  AgentStep,
  AgentStepKind,
  DecisionChoice,
  Proposal,
  ReviewChoice,
  RunFailure,
  SideEffectReceipt,
} from "../domain/model";
import {
  attachProposal,
  cancelRun,
  failRun,
  rebaseRunForAnalysis,
  recordReviewDecision,
  recordScopeDecision,
  retryRun,
  transitionRun,
} from "../domain/run-rules";
import { createEvent, type AgentRunEvent } from "./events";
import type {
  AgentRunStore,
  AgentStepExecutor,
  CancelledEffectReconciler,
  Clock,
  DocumentVersionCommitPort,
  EffectReceiptStore,
  IdGenerator,
} from "./ports";

const stepForStatus: Readonly<Record<ActiveRunStatus, AgentStepKind>> = {
  analyzing: "analyze",
  generating: "generate",
  applying: "apply",
  validating: "validate",
};

const nextStatus: Readonly<Record<ActiveRunStatus, AgentRunStatus>> = {
  analyzing: "awaiting_scope_confirmation",
  generating: "applying",
  applying: "validating",
  validating: "awaiting_review",
};

export type AdvanceOutcome =
  | { readonly kind: "progressed"; readonly run: AgentRun }
  | { readonly kind: "paused"; readonly run: AgentRun }
  | { readonly kind: "terminal"; readonly run: AgentRun };

export interface SubmitDecisionInput {
  readonly commandId: string;
  readonly decisionId: string;
  readonly choice: DecisionChoice;
  readonly decidedBy: string;
  /** Deprecated and ignored; the authoritative revision is loaded server-side. */
  readonly currentRevision?: string;
}

export interface SubmitReviewInput {
  readonly commandId: string;
  readonly decisionId: string;
  readonly choice: ReviewChoice;
  readonly decidedBy: string;
  readonly reviewedRevision: string;
}

export class AgentRuntime {
  constructor(
    private readonly store: AgentRunStore,
    private readonly executor: AgentStepExecutor,
    private readonly effectReceipts: EffectReceiptStore,
    private readonly documents: DocumentVersionCommitPort,
    private readonly cancelledEffects: CancelledEffectReconciler,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async advance(runId: string): Promise<AdvanceOutcome> {
    let run = await this.load(runId);
    if (run.status === "queued") run = await this.saveStatus(run, "analyzing");
    if (run.status === "completed" || run.status === "cancelled") {
      return { kind: "terminal", run };
    }
    if (
      run.status === "awaiting_scope_confirmation" ||
      run.status === "awaiting_review" ||
      run.status === "failed"
    ) {
      return { kind: "paused", run };
    }

    if (run.status === "applying" || run.status === "validating") {
      const actualRevision = await this.documents.getCurrentRevision(run.documentId);
      if (actualRevision !== run.baseRevision) {
        await this.persistRevisionConflict(run, actualRevision);
        throw new StaleDocumentRevisionError(run.baseRevision, actualRevision);
      }
    }

    const step = this.stepFor(run);
    const durableReceipt = await this.effectReceipts.load(step.idempotencyKey);
    if (durableReceipt) return this.finishReceipt(run, step, durableReceipt, true);

    const startedAt = this.clock.now();
    const running = this.updateStep(run, step.id, (current) => ({
      ...current,
      status: "running",
      attempts: current.attempts + 1,
      startedAt,
      error: undefined,
    }), startedAt);
    run = await this.persist(run, running, [
      this.event(running, "step.started", {
        stepId: step.id,
        kind: step.kind,
        attempt: step.attempts + 1,
      }),
      this.checkpointEvent(running),
    ]);

    try {
      const currentStep = this.stepFor(run);
      const result = await this.executor.executeOnce({
        run,
        step: currentStep,
        idempotencyKey: currentStep.idempotencyKey,
      });
      const completedAt = this.clock.now();
      const proposal: Proposal | undefined = result.proposal
        ? { ...result.proposal, runId: run.id, createdAt: completedAt }
        : undefined;
      if (currentStep.kind === "analyze" && !proposal) {
        throw new InvalidRunOperationError(
          "ANALYSIS_PROPOSAL_MISSING",
          "The analyze step must produce a review proposal.",
        );
      }
      if (currentStep.kind === "apply" && !result.derivedRevision) {
        throw new InvalidRunOperationError(
          "APPLY_DERIVED_REVISION_MISSING",
          "The apply step must return its immutable derived artifact revision.",
        );
      }
      const receipt = await this.effectReceipts.saveOnce({
        idempotencyKey: currentStep.idempotencyKey,
        stepId: currentStep.id,
        effect: currentStep.kind,
        outputRef: result.outputRef,
        providerReceiptRef: result.providerReceiptRef,
        committedAt: completedAt,
        proposal,
        derivedRevision: result.derivedRevision,
      });
      return await this.finishReceipt(run, currentStep, receipt, false);
    } catch (error) {
      if (error instanceof ConcurrentRunUpdateError) {
        const receipt = await this.effectReceipts.load(step.idempotencyKey);
        if (receipt) return this.reconcileIfCancelled(run.id, receipt);
        throw error;
      }
      if (error instanceof StaleDocumentRevisionError) throw error;
      const failure = normalizeFailure(error, run.status);
      const failedAt = this.clock.now();
      const currentStep = this.stepFor(run);
      const stepFailed = this.updateStep(run, currentStep.id, (item) => ({
        ...item,
        status: "failed",
        error: { ...failure, failedFrom: run.status },
      }), failedAt);
      const failed = failRun(stepFailed, failure, failedAt);
      const saved = await this.persist(run, failed, [
        this.event(failed, "step.failed", {
          stepId: currentStep.id,
          code: failure.code,
          retryable: failure.retryable,
        }),
        this.statusEvent(failed, run.status, "failed"),
      ]);
      return { kind: "paused", run: saved };
    }
  }

  async decide(runId: string, input: SubmitDecisionInput): Promise<AgentRun> {
    const run = await this.load(runId);
    const fingerprint = JSON.stringify([input.decisionId, input.choice, input.decidedBy]);
    const replay = this.commandReplay(run, input.commandId, "scope-decision", fingerprint);
    if (replay) return replay;
    const currentRevision = await this.documents.getCurrentRevision(run.documentId);
    if (currentRevision !== run.baseRevision) {
      await this.persistRevisionConflict(run, currentRevision);
      throw new StaleDocumentRevisionError(run.baseRevision, currentRevision);
    }
    const now = this.clock.now();
    const decided = this.recordCommand(recordScopeDecision(run, {
      id: input.decisionId,
      choice: input.choice,
      decidedBy: input.decidedBy,
      currentRevision,
      now,
    }), input.commandId, "scope-decision", fingerprint, now);
    return this.persistCommand(run, decided, [
      this.event(decided, "hitl.decision_frozen", {
        decisionId: input.decisionId,
        proposalId: decided.decision!.proposalId,
        choice: input.choice,
        decidedBy: input.decidedBy,
      }),
      this.statusEvent(decided, run.status, decided.status),
    ], input.commandId, "scope-decision", fingerprint);
  }

  async cancel(runId: string, commandId: string): Promise<AgentRun> {
    const run = await this.load(runId);
    const replay = this.commandReplay(run, commandId, "cancel", "cancel");
    if (replay) return replay;
    const now = this.clock.now();
    const cancelled = this.recordCommand(cancelRun(run, now), commandId, "cancel", "cancel", now);
    return this.persistCommand(run, cancelled, [
      this.event(cancelled, "run.cancelled", { previousStatus: run.status }),
      this.statusEvent(cancelled, run.status, "cancelled"),
    ], commandId, "cancel", "cancel");
  }

  async retry(runId: string, commandId: string): Promise<AgentRun> {
    const run = await this.load(runId);
    const replay = this.commandReplay(run, commandId, "retry", "retry");
    if (replay) return replay;
    const now = this.clock.now();
    const retried = this.recordCommand(retryRun(run, now), commandId, "retry", "retry", now);
    return this.persistCommand(run, retried, [
      this.event(retried, "run.retried", { resumeStatus: retried.status }),
      this.statusEvent(retried, "failed", retried.status),
    ], commandId, "retry", "retry");
  }

  async completeReview(runId: string, input: SubmitReviewInput): Promise<AgentRun> {
    const run = await this.load(runId);
    const fingerprint = JSON.stringify([
      input.decisionId,
      input.choice,
      input.decidedBy,
      input.reviewedRevision,
    ]);
    const replay = this.commandReplay(run, input.commandId, "review-decision", fingerprint);
    if (replay) return replay;
    const currentRevision = await this.documents.getCurrentRevision(run.documentId);
    if (
      !run.workingRevision ||
      currentRevision !== run.workingRevision ||
      input.reviewedRevision !== run.workingRevision
    ) {
      await this.persistReviewConflict(run, currentRevision);
      throw new StaleDocumentRevisionError(run.workingRevision ?? run.baseRevision, currentRevision);
    }
    const now = this.clock.now();
    if (input.choice === "rejected") {
      const rollback = await this.documents.rollbackRejectedVersion({
        runId,
        documentId: run.documentId,
        expectedRevision: run.workingRevision,
        idempotencyKey: `${input.commandId}:rollback`,
      });
      if (rollback.kind === "revision-conflict") {
        await this.persistReviewConflict(run, rollback.actualRevision);
        throw new StaleDocumentRevisionError(run.workingRevision, rollback.actualRevision);
      }
    }
    const decided = this.recordCommand(recordReviewDecision(run, {
      id: input.decisionId,
      choice: input.choice,
      decidedBy: input.decidedBy,
      reviewedRevision: input.reviewedRevision,
      currentRevision,
      now,
    }), input.commandId, "review-decision", fingerprint, now);
    return this.persistCommand(run, decided, [
      this.event(decided, "review.decision_frozen", {
        decisionId: input.decisionId,
        reviewedRevision: input.reviewedRevision,
        choice: input.choice,
        decidedBy: input.decidedBy,
      }),
      this.statusEvent(decided, run.status, decided.status),
    ], input.commandId, "review-decision", fingerprint);
  }

  private async finishReceipt(
    run: AgentRun,
    step: AgentStep,
    receipt: SideEffectReceipt,
    reused: boolean,
  ): Promise<AdvanceOutcome> {
    if (receipt.stepId !== step.id || receipt.effect !== step.kind) {
      throw new InvalidRunOperationError(
        "EFFECT_RECEIPT_MISMATCH",
        "Durable effect receipt does not belong to the active step.",
      );
    }
    // The apply step only creates an immutable temporary artifact. Promotion is
    // deliberately deferred until the validate step has reopened that artifact
    // and passed structural checks.
    if (step.kind === "validate") {
      if (!receipt.derivedRevision) {
        const applyReceipt = run.receipts.find((candidate) => candidate.effect === "apply");
        if (!applyReceipt?.derivedRevision) {
          throw new InvalidRunOperationError("APPLY_DERIVED_REVISION_MISSING", "The durable apply receipt has no derived revision.");
        }
        const commit = await this.documents.commitDerivedVersion({
          runId: run.id,
          expectedRunVersion: run.version,
          documentId: run.documentId,
          expectedRevision: run.baseRevision,
          derivedRevision: applyReceipt.derivedRevision,
          outputRef: applyReceipt.outputRef,
          idempotencyKey: `${applyReceipt.idempotencyKey}:commit`,
        });
        if (commit.kind === "revision-conflict") {
          await this.persistRevisionConflict(run, commit.actualRevision);
          throw new StaleDocumentRevisionError(run.baseRevision, commit.actualRevision);
        }
        if (commit.kind === "run-cancelled") return this.reconcileIfCancelled(run.id, applyReceipt);
      }
    }

    const now = this.clock.now();
    let completed = this.completeStep(run, step, receipt, now);
    completed = this.moveAfterStep(completed, step, receipt.proposal, now);
    const events: AgentRunEvent[] = [
      reused
        ? this.event(completed, "step.receipt_reused", {
            stepId: step.id,
            idempotencyKey: step.idempotencyKey,
          })
        : this.event(completed, "step.completed", {
            stepId: step.id,
            kind: step.kind,
            outputRef: receipt.outputRef,
          }),
      this.checkpointEvent(completed),
    ];
    if (step.kind === "analyze") {
      events.push(this.event(completed, "proposal.created", {
        proposalId: receipt.proposal!.id,
        baseRevision: receipt.proposal!.baseRevision,
        risk: receipt.proposal!.risk,
      }));
    }
    events.push(this.statusEvent(completed, run.status, completed.status));
    try {
      return { kind: "progressed", run: await this.persist(run, completed, events) };
    } catch (error) {
      if (error instanceof ConcurrentRunUpdateError) {
        return this.reconcileIfCancelled(run.id, receipt);
      }
      throw error;
    }
  }

  private async reconcileIfCancelled(
    runId: string,
    receipt: SideEffectReceipt,
  ): Promise<AdvanceOutcome> {
    const latest = await this.load(runId);
    if (latest.status !== "cancelled") throw new ConcurrentRunUpdateError(runId);
    await this.cancelledEffects.reconcileCancelled(latest, receipt);
    if (latest.receipts.some((item) => item.idempotencyKey === receipt.idempotencyKey)) {
      return { kind: "terminal", run: latest };
    }
    const now = this.clock.now();
    const reconciled = {
      ...latest,
      receipts: [...latest.receipts, receipt],
      updatedAt: now,
    };
    return {
      kind: "terminal",
      run: await this.persist(latest, reconciled, [
        this.event(reconciled, "step.cancelled_effect_reconciled", {
          stepId: receipt.stepId,
          idempotencyKey: receipt.idempotencyKey,
        }),
      ]),
    };
  }

  private async persistRevisionConflict(run: AgentRun, actualRevision: string): Promise<AgentRun> {
    const now = this.clock.now();
    const rebased = rebaseRunForAnalysis(run, actualRevision, now);
    return this.persist(run, rebased, [
      this.event(rebased, "run.revision_conflict", {
        expectedRevision: run.baseRevision,
        actualRevision,
      }),
      this.statusEvent(rebased, run.status, "analyzing"),
      this.checkpointEvent(rebased),
    ]);
  }

  private async persistReviewConflict(run: AgentRun, actualRevision: string): Promise<AgentRun> {
    const now = this.clock.now();
    return this.persist(run, { ...run, updatedAt: now }, [
      this.event(run, "run.revision_conflict", {
        expectedRevision: run.workingRevision ?? run.baseRevision,
        actualRevision,
      }),
    ]);
  }

  private async persistCommand(
    previous: AgentRun,
    next: AgentRun,
    events: readonly AgentRunEvent[],
    commandId: string,
    kind: AgentCommandKind,
    fingerprint: string,
  ): Promise<AgentRun> {
    try {
      return await this.persist(previous, next, events);
    } catch (error) {
      if (!(error instanceof ConcurrentRunUpdateError)) throw error;
      const latest = await this.load(previous.id);
      const replay = this.commandReplay(latest, commandId, kind, fingerprint);
      if (replay) return replay;
      throw error;
    }
  }

  private commandReplay(
    run: AgentRun,
    id: string,
    kind: AgentCommandKind,
    fingerprint: string,
  ): AgentRun | undefined {
    const prior = run.commands.find((command) => command.id === id);
    if (!prior) return undefined;
    if (prior.kind !== kind || prior.fingerprint !== fingerprint) throw new CommandConflictError(id);
    return run;
  }

  private recordCommand(
    run: AgentRun,
    id: string,
    kind: AgentCommandKind,
    fingerprint: string,
    now: string,
  ): AgentRun {
    return {
      ...run,
      commands: [...run.commands, {
        id,
        kind,
        fingerprint,
        resultingStatus: run.status,
        recordedAt: now,
      }],
    };
  }

  private async load(runId: string): Promise<AgentRun> {
    const run = await this.store.load(runId);
    if (!run) throw new RunNotFoundError(runId);
    return run;
  }

  private stepFor(run: AgentRun): AgentStep {
    const kind = stepForStatus[run.status as ActiveRunStatus];
    const step = run.steps.find((candidate) => candidate.kind === kind);
    if (!kind || !step) {
      throw new InvalidRunOperationError("NO_ACTIVE_STEP", `Run ${run.id} has no step for ${run.status}.`);
    }
    return step;
  }

  private completeStep(
    run: AgentRun,
    step: AgentStep,
    receipt: SideEffectReceipt,
    now: string,
  ): AgentRun {
    const receipts = run.receipts.some((item) => item.idempotencyKey === receipt.idempotencyKey)
      ? run.receipts
      : [...run.receipts, receipt];
    const updated = this.updateStep(run, step.id, (current) => ({
      ...current,
      status: "completed",
      outputRef: receipt.outputRef,
      completedAt: now,
      error: undefined,
    }), now);
    return {
      ...updated,
      receipts,
      ...(step.kind === "validate"
        ? { workingRevision: run.receipts.find((item) => item.effect === "apply")?.derivedRevision }
        : {}),
      checkpoint: {
        cursor: Math.max(
          updated.checkpoint.cursor,
          updated.steps.findIndex((item) => item.id === step.id) + 1,
        ),
        lastCompletedStepId: step.id,
        savedAt: now,
      },
    };
  }

  private moveAfterStep(
    run: AgentRun,
    step: AgentStep,
    proposal: Proposal | undefined,
    now: string,
  ): AgentRun {
    if (step.kind === "analyze") {
      if (!proposal) {
        throw new InvalidRunOperationError(
          "ANALYSIS_PROPOSAL_MISSING",
          "The analyze receipt does not contain its review proposal.",
        );
      }
      return attachProposal(run, proposal, now);
    }
    return transitionRun(run, nextStatus[run.status as ActiveRunStatus], now);
  }

  private updateStep(
    run: AgentRun,
    stepId: string,
    update: (step: AgentStep) => AgentStep,
    now: string,
  ): AgentRun {
    return {
      ...run,
      steps: run.steps.map((step) => (step.id === stepId ? update(step) : step)),
      checkpoint: { ...run.checkpoint, savedAt: now },
      updatedAt: now,
    };
  }

  private async saveStatus(run: AgentRun, status: AgentRunStatus): Promise<AgentRun> {
    const now = this.clock.now();
    const next = transitionRun(run, status, now);
    return this.persist(run, next, [this.statusEvent(next, run.status, status)]);
  }

  private statusEvent(run: AgentRun, from: AgentRunStatus, to: AgentRunStatus): AgentRunEvent {
    return this.event(run, "run.status_changed", { from, to });
  }

  private async persist(
    previous: AgentRun,
    next: AgentRun,
    events: readonly AgentRunEvent[],
  ): Promise<AgentRun> {
    const persistedEvents = events.map((event, index) => ({
      ...event,
      sequence: previous.eventCursor + index + 1,
    }));
    return this.store.save(
      {
        ...next,
        version: previous.version + 1,
        eventCursor: previous.eventCursor + persistedEvents.length,
      },
      previous.version,
      persistedEvents,
    );
  }

  private checkpointEvent(run: AgentRun): AgentRunEvent {
    return this.event(run, "checkpoint.saved", {
      cursor: run.checkpoint.cursor,
      lastCompletedStepId: run.checkpoint.lastCompletedStepId,
    });
  }

  private event<T extends AgentRunEvent["type"]>(
    run: AgentRun,
    type: T,
    data: Extract<AgentRunEvent, { type: T }>["data"],
  ): Extract<AgentRunEvent, { type: T }> {
    return createEvent(type, {
      id: this.ids.next("event"),
      runId: run.id,
      sequence: 0,
      occurredAt: this.clock.now(),
      data,
    } as unknown as Omit<Extract<AgentRunEvent, { type: T }>, "type">);
  }
}

function normalizeFailure(error: unknown, failedFrom: AgentRunStatus): Omit<RunFailure, "failedFrom"> {
  if (error instanceof InvalidRunOperationError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof StepExecutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      diagnostics: error.diagnostics,
    };
  }
  return {
    code: "STEP_EXECUTION_FAILED",
    message: `Agent step failed while run was ${failedFrom}.`,
    retryable: true,
  };
}
