import type { AgentLoopCheckpoint } from "@/modules/agent/application/loop";
import type { AgentRun, AgentRunStatus, AgentRuntimePendingInteraction } from "@/modules/agent/domain/model";

export type AgentRuntimeView = {
  runtimeStatus: AgentRunStatus | "idle";
  isRunning: boolean;
  isAwaitingApproval: boolean;
  isAwaitingUser: boolean;
  isTerminal: boolean;
  canCancel: boolean;
  canSend: boolean;
  permissionLocked: boolean;
  pendingInteraction?: AgentRuntimePendingInteraction;
};

export function resolveAgentRuntimeView(input: { run?: AgentRun; checkpoint?: Pick<AgentLoopCheckpoint, "status" | "pendingInteraction">; pendingInteraction?: AgentRuntimePendingInteraction }): AgentRuntimeView {
  const runtimeStatus = input.checkpoint?.status ?? input.run?.status ?? "idle";
  const pendingInteraction = input.checkpoint?.pendingInteraction ?? input.pendingInteraction ?? input.run?.pendingInteraction;
  const isRunning = runtimeStatus === "queued" || runtimeStatus === "running";
  const isAwaitingApproval = runtimeStatus === "awaiting_approval" || pendingInteraction?.type === "approval";
  const isAwaitingUser = runtimeStatus === "awaiting_user" || pendingInteraction?.type === "user_input";
  const isTerminal = runtimeStatus === "completed" || runtimeStatus === "failed" || runtimeStatus === "cancelled";
  return {
    runtimeStatus,
    isRunning,
    isAwaitingApproval,
    isAwaitingUser,
    isTerminal,
    canCancel: isRunning || runtimeStatus === "awaiting_client",
    canSend: runtimeStatus === "idle" || isAwaitingUser || isTerminal,
    permissionLocked: isRunning || isAwaitingApproval || isAwaitingUser || runtimeStatus === "awaiting_client",
    pendingInteraction,
  };
}
