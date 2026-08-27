import { performance } from "node:perf_hooks";

import { logger, slowThresholds } from "./logger";
import { serializeError } from "./redaction";
import type { LogMetadata, TimingMark } from "../types";

export const createTimer = (operation: string, metadata: LogMetadata = {}) => {
  const started = performance.now();
  const marks: TimingMark[] = [];
  return {
    mark(name: string) { marks.push({ name, durationMs: Math.round((performance.now() - started) * 100) / 100 }); },
    elapsed: () => Math.round((performance.now() - started) * 100) / 100,
    marks: () => [...marks],
    operation,
    metadata,
  };
};

export const measure = async <T>(operation: string, metadata: LogMetadata, action: (timer: ReturnType<typeof createTimer>) => Promise<T>): Promise<T> => {
  const timer = createTimer(operation, metadata);
  try {
    const result = await action(timer);
    const durationMs = timer.elapsed();
    const threshold = slowThresholds[operation];
    logger.info(`${operation}.completed`, { ...metadata, durationMs, slow: threshold !== undefined && durationMs >= threshold, timingMarks: timer.marks(), outcome: "success" });
    if (threshold !== undefined && durationMs >= threshold) logger.warn(`${operation}.slow`, { ...metadata, durationMs, slow: true, outcome: "success" });
    return result;
  } catch (error) {
    const durationMs = timer.elapsed();
    logger.error(`${operation}.failed`, { ...metadata, durationMs, error: serializeError(error), outcome: "failure" });
    throw error;
  }
};
