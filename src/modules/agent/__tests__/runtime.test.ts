import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  CommandConflictError,
  ConcurrentRunUpdateError,
  StaleDocumentRevisionError,
  createAgentRun,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunStore,
  type AgentStepExecutor,
  type CancelledEffectReconciler,
  type Clock,
  type CommitDerivedVersionInput,
  type CommitDerivedVersionResult,
  type DocumentVersionCommitPort,
  type EffectReceiptStore,
  type IdGenerator,
  type SideEffectReceipt,
  type StepExecutionContext,
  type StepExecutionResult,
} from "..";

class TestClock implements Clock {
  private tick = 0;
  now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString();
  }
}

class TestIds implements IdGenerator {
  private value = 0;
  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${this.value}`;
  }
}

class MemoryRunStore implements AgentRunStore {
  readonly events: AgentRunEvent[] = [];
  failOnSaveNumber?: number;
  private saveCount = 0;

  constructor(private run: AgentRun) {}

  async load(runId: string): Promise<AgentRun | null> {
    return this.run.id === runId ? structuredClone(this.run) : null;
  }

  peek(): AgentRun {
    return structuredClone(this.run);
  }

  async save(run: AgentRun, expectedVersion: number, events: readonly AgentRunEvent[]): Promise<AgentRun> {
    this.saveCount += 1;
    if (this.failOnSaveNumber === this.saveCount) throw new Error("simulated persistence interruption");
    if (this.run.version !== expectedVersion) throw new ConcurrentRunUpdateError(run.id);
    this.run = structuredClone(run);
    this.events.push(...structuredClone(events));
    return structuredClone(this.run);
  }
}

class MemoryEffectReceipts implements EffectReceiptStore {
  readonly values = new Map<string, SideEffectReceipt>();
  async load(key: string): Promise<SideEffectReceipt | null> {
    return structuredClone(this.values.get(key) ?? null);
  }
  async saveOnce(receipt: SideEffectReceipt): Promise<SideEffectReceipt> {
    const prior = this.values.get(receipt.idempotencyKey);
    if (prior) return structuredClone(prior);
    this.values.set(receipt.idempotencyKey, structuredClone(receipt));
    return structuredClone(receipt);
  }
}

class MemoryDocuments implements DocumentVersionCommitPort {
  currentRevision = "revision-1";
  beforeCommit?: () => void;
  readonly commits = new Map<string, CommitDerivedVersionResult>();

  constructor(private readonly runs: MemoryRunStore) {}

  async getCurrentRevision(): Promise<string> {
    return this.currentRevision;
  }

  async commitDerivedVersion(input: CommitDerivedVersionInput): Promise<CommitDerivedVersionResult> {
    const prior = this.commits.get(input.idempotencyKey);
    if (prior) return prior;
    this.beforeCommit?.();
    this.beforeCommit = undefined;
    const run = this.runs.peek();
    if (run.status === "cancelled" || run.version !== input.expectedRunVersion) {
      return { kind: "run-cancelled" };
    }
    if (this.currentRevision !== input.expectedRevision) {
      return { kind: "revision-conflict", actualRevision: this.currentRevision };
    }
    this.currentRevision = input.derivedRevision;
    const result = { kind: "committed" as const, versionRef: `version://${input.derivedRevision}` };
    this.commits.set(input.idempotencyKey, result);
    return result;
  }

  async rollbackRejectedVersion(input: {
    runId: string;
    documentId: string;
    expectedRevision: string;
    idempotencyKey: string;
  }) {
    const prior = this.commits.get(input.idempotencyKey);
    if (prior && prior.kind === "committed") {
      return { kind: "rolled-back" as const, versionRef: prior.versionRef, revision: "revision-1" };
    }
    if (this.currentRevision !== input.expectedRevision) {
      return { kind: "revision-conflict" as const, actualRevision: this.currentRevision };
    }
    this.currentRevision = "revision-1";
    const result = { kind: "rolled-back" as const, versionRef: `restore://${input.runId}`, revision: this.currentRevision };
    this.commits.set(input.idempotencyKey, { kind: "committed", versionRef: result.versionRef });
    return result;
  }
}

class RecordingReconciler implements CancelledEffectReconciler {
  readonly receipts: SideEffectReceipt[] = [];
  async reconcileCancelled(_run: AgentRun, receipt: SideEffectReceipt): Promise<void> {
    if (!this.receipts.some((item) => item.idempotencyKey === receipt.idempotencyKey)) {
      this.receipts.push(structuredClone(receipt));
    }
  }
}

class DeterministicExecutor implements AgentStepExecutor {
  readonly attempts = new Map<string, number>();
  failKindsOnce = new Set<string>();

  async executeOnce(context: StepExecutionContext): Promise<StepExecutionResult> {
    const key = context.idempotencyKey;
    this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
    if (this.failKindsOnce.delete(context.step.kind)) throw new Error("temporary provider failure");
    if (context.step.kind === "analyze") {
      return {
        outputRef: "manifest://analysis",
        proposal: {
          id: `proposal-${context.run.cycle}`,
          baseRevision: context.run.baseRevision,
          summary: "Regenerate answer cells.",
          risk: "high",
        },
      };
    }
    if (context.step.kind === "apply") {
      return { outputRef: "oss://derived.docx", derivedRevision: `derived-${context.run.cycle}` };
    }
    return { outputRef: `${context.step.kind}://result` };
  }
}

class DeferredExecutor extends DeterministicExecutor {
  private releasePromise!: (value: StepExecutionResult) => void;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  readonly pending = new Promise<StepExecutionResult>((resolve) => {
    this.releasePromise = resolve;
  });

  override async executeOnce(context: StepExecutionContext): Promise<StepExecutionResult> {
    if (context.step.kind === "generate") {
      this.markStarted();
      return this.pending;
    }
    return super.executeOnce(context);
  }

  release(value: StepExecutionResult): void {
    this.releasePromise(value);
  }
}

interface Harness {
  store: MemoryRunStore;
  effects: MemoryEffectReceipts;
  documents: MemoryDocuments;
  reconciler: RecordingReconciler;
  executor: DeterministicExecutor;
  runtime: AgentRuntime;
  clock: TestClock;
}

function setup(executor: DeterministicExecutor = new DeterministicExecutor()): Harness {
  const clock = new TestClock();
  const store = new MemoryRunStore(createAgentRun({
    id: "run-1",
    documentId: "document-1",
    baseRevision: "revision-1",
    now: clock.now(),
  }));
  const effects = new MemoryEffectReceipts();
  const documents = new MemoryDocuments(store);
  const reconciler = new RecordingReconciler();
  return {
    store,
    effects,
    documents,
    reconciler,
    executor,
    clock,
    runtime: new AgentRuntime(
      store,
      executor,
      effects,
      documents,
      reconciler,
      clock,
      new TestIds(),
    ),
  };
}

async function analyzeAndApprove(harness: Harness): Promise<void> {
  await harness.runtime.advance("run-1");
  await harness.runtime.decide("run-1", {
    commandId: "command-approve",
    decisionId: "decision-1",
    choice: "approved",
    decidedBy: "user-1",
  });
}

async function reachReview(harness: Harness): Promise<AgentRun> {
  await analyzeAndApprove(harness);
  await harness.runtime.advance("run-1");
  await harness.runtime.advance("run-1");
  return (await harness.runtime.advance("run-1")).run;
}

describe("AgentRuntime durable execution", () => {
  it("runs the full checkpointed flow and commits apply with document/run CAS", async () => {
    const harness = setup();
    const reviewed = await reachReview(harness);

    expect(reviewed.status).toBe("awaiting_review");
    expect(reviewed.workingRevision).toBe("derived-0");
    expect(harness.documents.currentRevision).toBe("derived-0");
    expect(reviewed.checkpoint.cursor).toBe(4);
    expect(reviewed.receipts).toHaveLength(4);
    expect(harness.effects.values.size).toBe(4);
    expect(harness.store.events.map((event) => event.sequence)).toEqual(
      harness.store.events.map((_, index) => index + 1),
    );
  });

  it("recovers a durable receipt with a fresh executor after result persistence fails", async () => {
    const harness = setup();
    harness.store.failOnSaveNumber = 3;
    const failed = await harness.runtime.advance("run-1");
    expect(failed.run.status).toBe("failed");
    expect(harness.effects.values.size).toBe(1);

    await harness.runtime.retry("run-1", "command-retry");
    const freshExecutor = new DeterministicExecutor();
    const freshRuntime = new AgentRuntime(
      harness.store,
      freshExecutor,
      harness.effects,
      harness.documents,
      harness.reconciler,
      harness.clock,
      new TestIds(),
    );
    const resumed = await freshRuntime.advance("run-1");
    expect(resumed.run.status).toBe("awaiting_scope_confirmation");
    expect(freshExecutor.attempts.size).toBe(0);
    expect(resumed.run.receipts).toHaveLength(1);
  });

  it("reconciles an effect that finishes after concurrent cancellation", async () => {
    const deferred = new DeferredExecutor();
    const harness = setup(deferred);
    await analyzeAndApprove(harness);

    const advancing = harness.runtime.advance("run-1");
    await deferred.started;
    const cancelled = await harness.runtime.cancel("run-1", "command-cancel");
    expect(cancelled.status).toBe("cancelled");
    deferred.release({ outputRef: "provider://generated-after-cancel" });

    const outcome = await advancing;
    expect(outcome.kind).toBe("terminal");
    expect(outcome.run.status).toBe("cancelled");
    expect(outcome.run.receipts).toHaveLength(2);
    expect(harness.reconciler.receipts).toHaveLength(1);
    expect(harness.store.events).toContainEqual(
      expect.objectContaining({ type: "step.cancelled_effect_reconciled" }),
    );
  });

  it("turns a CAS revision race into an audited new analysis cycle", async () => {
    const harness = setup();
    await analyzeAndApprove(harness);
    await harness.runtime.advance("run-1");
    await harness.runtime.advance("run-1");
    harness.documents.beforeCommit = () => {
      harness.documents.currentRevision = "revision-concurrent";
    };

    await expect(harness.runtime.advance("run-1")).rejects.toBeInstanceOf(
      StaleDocumentRevisionError,
    );
    const rebased = harness.store.peek();
    expect(rebased).toMatchObject({
      status: "analyzing",
      baseRevision: "revision-concurrent",
      cycle: 1,
      proposal: undefined,
      decision: undefined,
    });
    expect(rebased.steps.every((step) => step.status === "pending")).toBe(true);
    expect(harness.store.events).toContainEqual(
      expect.objectContaining({ type: "run.revision_conflict" }),
    );
  });
});

describe("AgentRuntime HITL commands", () => {
  it("uses authoritative revision, persists a conflict, and reanalyzes", async () => {
    const harness = setup();
    await harness.runtime.advance("run-1");
    harness.documents.currentRevision = "revision-2";

    await expect(harness.runtime.decide("run-1", {
      commandId: "command-stale",
      decisionId: "decision-stale",
      choice: "approved",
      decidedBy: "user-1",
      currentRevision: "revision-1",
    })).rejects.toBeInstanceOf(StaleDocumentRevisionError);
    expect(harness.store.peek()).toMatchObject({
      status: "analyzing",
      baseRevision: "revision-2",
      cycle: 1,
    });
  });

  it("replays the same decision command and rejects command id payload reuse", async () => {
    const harness = setup();
    await harness.runtime.advance("run-1");
    const input = {
      commandId: "command-decision",
      decisionId: "decision-1",
      choice: "approved" as const,
      decidedBy: "user-1",
    };
    const first = await harness.runtime.decide("run-1", input);
    const eventCount = harness.store.events.length;
    const replay = await harness.runtime.decide("run-1", input);
    expect(replay.version).toBe(first.version);
    expect(harness.store.events).toHaveLength(eventCount);

    await expect(harness.runtime.decide("run-1", {
      ...input,
      choice: "rejected",
    })).rejects.toBeInstanceOf(CommandConflictError);
  });

  it("binds final review to the committed revision and makes it replay-safe", async () => {
    const harness = setup();
    await reachReview(harness);
    const input = {
      commandId: "command-review",
      decisionId: "review-1",
      choice: "approved" as const,
      decidedBy: "reviewer-1",
      reviewedRevision: "derived-0",
    };
    const completed = await harness.runtime.completeReview("run-1", input);
    expect(completed).toMatchObject({
      status: "completed",
      reviewDecision: { reviewedRevision: "derived-0", frozen: true },
    });
    const replay = await harness.runtime.completeReview("run-1", input);
    expect(replay.version).toBe(completed.version);
  });

  it("rejects final review after the committed document revision changes", async () => {
    const harness = setup();
    await reachReview(harness);
    harness.documents.currentRevision = "derived-by-another-run";
    await expect(harness.runtime.completeReview("run-1", {
      commandId: "command-stale-review",
      decisionId: "review-stale",
      choice: "approved",
      decidedBy: "reviewer-1",
      reviewedRevision: "derived-0",
    })).rejects.toBeInstanceOf(StaleDocumentRevisionError);
    expect(harness.store.peek().status).toBe("awaiting_review");
  });

  it("rolls back the derived version when final review rejects it", async () => {
    const harness = setup();
    await reachReview(harness);
    const rejected = await harness.runtime.completeReview("run-1", {
      commandId: "command-review-reject",
      decisionId: "review-reject",
      choice: "rejected",
      decidedBy: "reviewer-1",
      reviewedRevision: "derived-0",
    });
    expect(rejected.status).toBe("cancelled");
    expect(harness.documents.currentRevision).toBe("revision-1");
    expect(rejected.reviewDecision).toMatchObject({ choice: "rejected", frozen: true });
  });

  it("retries only retryable failed work with an idempotent retry command", async () => {
    const harness = setup();
    await analyzeAndApprove(harness);
    harness.executor.failKindsOnce.add("generate");
    const failed = await harness.runtime.advance("run-1");
    expect(failed.run.status).toBe("failed");
    const retried = await harness.runtime.retry("run-1", "command-retry");
    const replay = await harness.runtime.retry("run-1", "command-retry");
    expect(replay.version).toBe(retried.version);
    expect(retried.status).toBe("generating");
  });
});
