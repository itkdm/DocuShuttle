import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@/infrastructure/observability";
import { snapshotAgentTraceValue } from "./serializer";
import type { AgentExecutionTracePort, AgentTraceSegmentKind } from "../../application/trace";

export type { AgentExecutionTracePort, AgentTraceSegmentKind } from "../../application/trace";

type FileTraceOptions = { rootDir: string; runId: string; loggerWarn?: (event: string, metadata: Record<string, unknown>) => void };

export class FileAgentExecutionTrace implements AgentExecutionTracePort {
  private readonly runDir: string;
  private readonly iterationDir: string;
  private readonly ndjsonPath: string;
  private queue = Promise.resolve();

  constructor(private readonly options: FileTraceOptions) {
    this.runDir = join(options.rootDir, options.runId);
    this.iterationDir = join(this.runDir, "iterations");
    this.ndjsonPath = join(this.runDir, "trace.ndjson");
  }

  snapshot(value: unknown) { return snapshotAgentTraceValue(value); }

  private enqueue(operation: () => Promise<void>) {
    this.queue = this.queue.then(operation).catch((error) => {
      (this.options.loggerWarn ?? ((event, metadata) => logger.warn(event, metadata)))("agent.trace.write_failed", { runId: this.options.runId, error });
    });
  }

  private mergeRun(existing: Record<string, unknown>, update: Record<string, unknown>) {
    const merged = { ...existing, ...update };
    const firstWriteFields = ["startedAt", "provider", "model", "reasoningMode", "maxOutputTokens", "maxIterations", "maxToolCalls", "modelIdleTimeoutMs", "modelMaxDurationMs", "contextCompactionPolicy", "toolNames"];
    for (const field of firstWriteFields) {
      if (existing[field] !== undefined) merged[field] = existing[field];
    }
    return merged;
  }

  beginRun(input: Record<string, unknown>) {
    const snapshot = snapshotAgentTraceValue(input) as Record<string, unknown>;
    this.enqueue(async () => {
      await mkdir(this.iterationDir, { recursive: true });
      const existing = await this.readRun();
      await this.atomicJson(join(this.runDir, "run.json"), { ...this.mergeRun(existing, snapshot), schemaVersion: 1 });
    });
  }

  finishRun(input: Record<string, unknown>) {
    const snapshot = snapshotAgentTraceValue(input) as Record<string, unknown>;
    this.enqueue(async () => {
      await mkdir(this.iterationDir, { recursive: true });
      await this.atomicJson(join(this.runDir, "run.json"), { ...this.mergeRun(await this.readRun(), snapshot), schemaVersion: 1 });
    });
  }

  updateRun(input: Record<string, unknown>) { this.finishRun(input); }

  writeConversationHistory(value: Record<string, unknown>) {
    const snapshot = snapshotAgentTraceValue(value) as Record<string, unknown>;
    this.enqueue(async () => {
      await mkdir(this.iterationDir, { recursive: true });
      await this.atomicJson(join(this.runDir, "conversation-history.json"), { schemaVersion: 1, ...snapshot });
    });
  }

  beginSegment(input: { kind: AgentTraceSegmentKind; segmentId?: string }) {
    const id = input.segmentId ?? crypto.randomUUID();
    this.record({ type: "run.segment.started", segmentId: id, payload: { kind: input.kind, startedAt: new Date().toISOString() } });
    return id;
  }

  endSegment(segmentId: string, input: Record<string, unknown> = {}) {
    const failed = input.outcome === "failed";
    this.record({ type: failed ? "run.segment.failed" : "run.segment.completed", segmentId, payload: { ...input, finishedAt: new Date().toISOString() } });
  }

  record(input: { type: string; segmentId?: string; iteration?: number; callId?: string; payload?: unknown }) {
    let envelope: unknown;
    try { envelope = snapshotAgentTraceValue({ schemaVersion: 1, timestamp: new Date().toISOString(), runId: this.options.runId, ...input }); }
    catch (error) { (this.options.loggerWarn ?? ((event, metadata) => logger.warn(event, metadata)))("agent.trace.write_failed", { runId: this.options.runId, error }); return; }
    this.enqueue(async () => { await mkdir(this.runDir, { recursive: true }); await appendFile(this.ndjsonPath, `${JSON.stringify(envelope)}\n`, "utf8"); });
  }

  writeIteration(iteration: number, value: Record<string, unknown>) {
    const snapshot = snapshotAgentTraceValue(value) as Record<string, unknown>;
    this.enqueue(async () => {
      await mkdir(this.iterationDir, { recursive: true });
      await this.atomicJson(join(this.iterationDir, `${String(iteration).padStart(3, "0")}.json`), { schemaVersion: 1, ...snapshot });
    });
  }

  appendIterationToolResolution(iteration: number, resolution: Record<string, unknown>) {
    const snapshot = snapshotAgentTraceValue(resolution) as Record<string, unknown>;
    this.enqueue(async () => {
      await mkdir(this.iterationDir, { recursive: true });
      const path = join(this.iterationDir, `${String(iteration).padStart(3, "0")}.json`);
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; } catch { return; }
      const resolutions = Array.isArray(existing.toolResolutions) ? existing.toolResolutions as Array<Record<string, unknown>> : [];
      const duplicate = resolutions.some((item) => item.callId === snapshot.callId && item.executionSource === snapshot.executionSource);
      if (!duplicate) resolutions.push(snapshot);
      await this.atomicJson(path, { ...existing, toolResolutions: resolutions });
    });
  }

  async findCallOriginIteration(callId: string): Promise<number | null> {
    try {
      const files = (await readdir(this.iterationDir)).filter((file) => /^\d+\.json$/.test(file)).sort();
      for (const file of files) {
        const value = JSON.parse(await readFile(join(this.iterationDir, file), "utf8")) as { model?: { calls?: Array<{ id?: string }> } };
        if (value.model?.calls?.some((call) => call.id === callId)) return Number.parseInt(file, 10);
      }
    } catch { /* tracing lookup is best effort */ }
    return null;
  }

  async flush() { await this.queue; }

  private async atomicJson(path: string, value: unknown) {
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await rename(temp, path);
  }

  private async readRun(): Promise<Record<string, unknown>> {
    try { return JSON.parse(await readFile(join(this.runDir, "run.json"), "utf8")) as Record<string, unknown>; }
    catch { return {}; }
  }
}

export const isAgentTraceEnabled = (env: NodeJS.ProcessEnv = process.env) => env.PAPERDUCK_AGENT_TRACE === "full" || (env.PAPERDUCK_AGENT_TRACE !== "off" && env.NODE_ENV === "development");

export const createFileAgentExecutionTrace = (runId: string, env: NodeJS.ProcessEnv = process.env) => {
  if (!isAgentTraceEnabled(env)) return undefined;
  return new FileAgentExecutionTrace({ rootDir: env.PAPERDUCK_AGENT_TRACE_DIR || "debug/agent-traces", runId });
};
