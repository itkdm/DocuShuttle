import { IllegalRunTransitionError } from "./errors";
import type { AgentRunStatus } from "./model";

const transitions: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["awaiting_approval", "awaiting_user", "awaiting_review", "completed", "failed", "cancelled"],
  awaiting_approval: ["running", "failed", "cancelled"],
  awaiting_user: ["running", "failed", "cancelled"],
  awaiting_review: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued", "running", "cancelled"],
  cancelled: [],
};

export function canTransition(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: AgentRunStatus, to: AgentRunStatus): void {
  if (!canTransition(from, to)) throw new IllegalRunTransitionError(from, to);
}

export function isTerminalStatus(status: AgentRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
