import { IllegalRunTransitionError } from "./errors";
import type { AgentRunStatus } from "./model";

const transitions: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  queued: ["analyzing", "cancelled", "failed"],
  analyzing: ["awaiting_scope_confirmation", "cancelled", "failed"],
  awaiting_scope_confirmation: ["analyzing", "generating", "cancelled", "failed"],
  generating: ["applying", "cancelled", "failed"],
  applying: ["analyzing", "validating", "cancelled", "failed"],
  validating: ["awaiting_review", "cancelled", "failed"],
  awaiting_review: ["completed", "generating", "cancelled", "failed"],
  completed: [],
  failed: [
    "queued",
    "analyzing",
    "awaiting_scope_confirmation",
    "generating",
    "applying",
    "validating",
    "awaiting_review",
    "cancelled",
  ],
  cancelled: [],
};

export function canTransition(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: AgentRunStatus, to: AgentRunStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalRunTransitionError(from, to);
  }
}

export function isTerminalStatus(status: AgentRunStatus): boolean {
  return status === "completed" || status === "cancelled";
}
