export type AgentTraceSegmentKind = "loop" | "approval_resume" | "user_input_resume" | "client_tool_resume" | "recover";

export type AgentExecutionTracePort = {
  beginRun(input: Record<string, unknown>): void;
  finishRun(input: Record<string, unknown>): void;
  updateRun(input: Record<string, unknown>): void;
  writeConversationHistory(value: Record<string, unknown>): void;
  beginSegment(input: { kind: AgentTraceSegmentKind; segmentId?: string }): string;
  endSegment(segmentId: string, input?: Record<string, unknown>): void;
  record(input: { type: string; segmentId?: string; iteration?: number; callId?: string; payload?: unknown }): void;
  writeIteration(iteration: number, value: Record<string, unknown>): void;
  flush(): Promise<void>;
};
