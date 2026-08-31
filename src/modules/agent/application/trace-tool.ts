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
  const resolution = {
    callId: input.callId,
    toolName: input.toolName,
    executionLocation: input.executionLocation,
    executionSource: input.executionSource,
    originIteration: input.iteration ?? null,
    modelProposedInput: input.modelProposedInput,
    validatedInput: input.validatedInput,
    rawOutput: input.rawOutput,
    modelFacingContent: input.modelFacingContent,
    eventFacingOutput: input.eventFacingOutput,
    durationMs: input.durationMs,
    error: input.error,
  };
  if (input.iteration !== undefined) trace?.appendIterationToolResolution?.(input.iteration, resolution);
  trace?.record({
    type: input.error === undefined ? "tool.completed" : "tool.failed",
    segmentId: input.segmentId,
    iteration: input.iteration,
    callId: input.callId,
    payload: {
      ...resolution,
      executionLocation: input.executionLocation,
      executionSource: input.executionSource,
    },
  });
};
