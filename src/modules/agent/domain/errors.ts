export class AgentDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class IllegalRunTransitionError extends AgentDomainError {
  constructor(from: string, to: string) {
    super("ILLEGAL_RUN_TRANSITION", `Agent run cannot transition from ${from} to ${to}.`);
  }
}

export class RunNotFoundError extends AgentDomainError {
  constructor(runId: string) {
    super("RUN_NOT_FOUND", `Agent run ${runId} was not found.`);
  }
}

export class ConcurrentRunUpdateError extends AgentDomainError {
  constructor(runId: string) {
    super("CONCURRENT_RUN_UPDATE", `Agent run ${runId} changed while it was being updated.`);
  }
}

export class CommandConflictError extends AgentDomainError {
  constructor(commandId: string) {
    super(
      "COMMAND_ID_CONFLICT",
      `Command ${commandId} was already used with a different operation or payload.`,
    );
  }
}

export class StaleDocumentRevisionError extends AgentDomainError {
  constructor(
    public readonly expectedRevision: string,
    public readonly actualRevision: string,
  ) {
    super(
      "STALE_DOCUMENT_REVISION",
      `Proposal targets document revision ${expectedRevision}, but the current revision is ${actualRevision}.`,
    );
  }
}

export class DecisionFrozenError extends AgentDomainError {
  constructor(proposalId: string) {
    super("DECISION_FROZEN", `The decision for proposal ${proposalId} is already frozen.`);
  }
}

export class InvalidRunOperationError extends AgentDomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** A provider adapter may expose only already-redacted failure details through this type. */
export class StepExecutionError extends AgentDomainError {
  constructor(
    code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly diagnostics?: Readonly<Record<string, string>>,
  ) {
    super(code, message);
  }
}
