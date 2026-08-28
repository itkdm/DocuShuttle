import type { AgentEvent } from "./events";
import type { AgentLoopCheckpoint, AgentLoopResult, AgentPermissionMode } from "./loop";
import type { AgentRuntimePendingInteraction } from "../domain/model";

export type PublicAgentLoopCheckpoint = {
  status: AgentLoopCheckpoint["status"];
  finalText?: string;
  iterations: number;
  pendingInteraction?: AgentRuntimePendingInteraction;
  permissionMode?: AgentPermissionMode;
};

export type PublicAgentLoopResult = {
  checkpoint: PublicAgentLoopCheckpoint;
  events: AgentEvent[];
};

/** Explicit server-to-browser allowlist; internal transcript fields never cross this boundary. */
export const projectAgentLoopCheckpointForClient = (checkpoint: AgentLoopCheckpoint): PublicAgentLoopCheckpoint => ({
  status: checkpoint.status,
  finalText: checkpoint.finalText,
  iterations: checkpoint.iterations,
  pendingInteraction: checkpoint.pendingInteraction,
  permissionMode: checkpoint.permissionMode,
});

export const projectAgentLoopResultForClient = (result: AgentLoopResult): PublicAgentLoopResult => ({
  checkpoint: projectAgentLoopCheckpointForClient(result.checkpoint),
  events: [...result.events],
});
