import type { AgentRunStatus } from "../domain/model";

export type AgentEventEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly payload: TPayload;
};

export type AgentRunEvent = AgentEventEnvelope & {
  readonly type: `run.${string}` | `model.${string}` | `tool.${string}` | `approval.${string}` | `turn.${string}` | `checkpoint.${string}`;
  readonly payload: Record<string, unknown> & { from?: AgentRunStatus; to?: AgentRunStatus };
};
