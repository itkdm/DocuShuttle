/** The durable lifecycle of one user-initiated Agent execution. */
export type AgentRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRuntimePendingInteraction =
  | { readonly interactionId: string; readonly type: "approval"; readonly callId: string; readonly toolName: string; readonly input: unknown }
  | { readonly interactionId: string; readonly type: "user_input"; readonly question: string };

export type AgentInteractionResolution =
  | { readonly interactionId: string; readonly type: "approval"; readonly callId: string; readonly toolName: string; readonly input: unknown; readonly decision: "approved" | "rejected" }
  | { readonly interactionId: string; readonly type: "user_input"; readonly messageId: string; readonly text: string };

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
  readonly pendingInteraction?: AgentRuntimePendingInteraction;
  readonly failure?: AgentRunFailure;
  readonly lockVersion: number;
  readonly leaseExpiresAt?: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}
