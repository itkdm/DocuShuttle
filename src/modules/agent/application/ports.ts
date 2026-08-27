import type { AgentRun } from "../domain/model";

export interface AgentRunStore {
  load(runId: string): Promise<AgentRun | null>;
  createForTask(input: { taskId: string; ownerUserId: string; now: string; goal?: string; clientMessageId?: string }): Promise<AgentRun>;
}
