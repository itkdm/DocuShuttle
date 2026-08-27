/** The durable lifecycle of one user-initiated Agent execution. */
export type AgentRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_user"
  | "awaiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentPendingInteraction =
  | { readonly type: "approval"; readonly callId: string; readonly toolName: string; readonly input: unknown }
  | { readonly type: "user_input"; readonly question: string }
  | { readonly type: "final_review"; readonly revision: string };

export type AgentRunFailure = {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
};

/** Tool execution state belongs to the runtime checkpoint and event store. */
export interface AgentRun {
  readonly id: string;
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly documentId?: string;
  readonly baseRevision?: string;
  readonly status: AgentRunStatus;
  readonly pendingInteraction?: AgentPendingInteraction;
  readonly failure?: AgentRunFailure;
  readonly lockVersion: number;
  readonly leaseExpiresAt?: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}
