import type { AgentExecutionTracePort } from "./trace";

/**
 * Observability-only projection of one tool resolution. It deliberately does
 * not serialize or alter any value used by the runtime; the trace adapter is
 * responsible for its safe snapshot.
 */
export const recordToolResolution = (trace: AgentExecutionTracePort | undefined, input: {
  segmentId?: string;
  iteration?: number;
  callId: string;
  toolName: string;
  executionLocation: "server" | "browser";
  executionSource: string;
  modelProposedInput?: unknown;
  validatedInput?: unknown;
  rawOutput?: unknown;
  modelFacingContent?: unknown;
  eventFacingOutput?: unknown;
  durationMs?: number;
  error?: unknown;
}) => {
  trace?.record({
    type: input.error === undefined ? "tool.completed" : "tool.failed",
    segmentId: input.segmentId,
    iteration: input.iteration,
    callId: input.callId,
    payload: {
      toolName: input.toolName,
      executionLocation: input.executionLocation,
      executionSource: input.executionSource,
      modelProposedInput: input.modelProposedInput,
      validatedInput: input.validatedInput,
      rawOutput: input.rawOutput,
      modelFacingOutput: input.modelFacingContent,
      eventFacingOutput: input.eventFacingOutput,
      durationMs: input.durationMs,
      error: input.error,
    },
  });
};
