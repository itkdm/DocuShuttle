import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAgentTraceValue } from "../infrastructure/trace/serializer";
import { FileAgentExecutionTrace, createFileAgentExecutionTrace, isAgentTraceEnabled } from "../infrastructure/trace/writer";

describe("Agent Execution Trace V1", () => {
  it("preserves ordinary values while redacting credentials, binary, data URLs, and reasoning", () => {
    const result = serializeAgentTraceValue({
      text: "完整工具结果",
      apiKey: "secret-value",
      authorization: "Bearer secret",
      signedUrl: "https://example.test/signed",
      reasoning: "private chain",
      bytes: new Uint8Array([1, 2, 3]),
      image: "data:image/png;base64,AAAA",
      nested: { password: "hidden" },
    }) as Record<string, unknown>;
    expect(result.text).toBe("完整工具结果");
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.authorization).toBe("[REDACTED]");
    expect(result.signedUrl).toBe("[REDACTED]");
    expect(result.reasoning).toEqual({ omitted: true, characters: 13 });
    expect(result.bytes).toEqual({ omitted: true, type: "Uint8Array", byteLength: 3 });
    expect(result.image).toEqual({ omitted: true, type: "data-url" });
  });

  it("writes schema-versioned materialized files and NDJSON without blocking callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperduck-agent-trace-"));
    const trace = new FileAgentExecutionTrace({ rootDir: root, runId: "run-1" });
    trace.beginRun({ runId: "run-1", taskId: "task-1" });
    const segmentId = trace.beginSegment({ kind: "loop", segmentId: "segment-1" });
    trace.record({ type: "iteration.started", segmentId, iteration: 1, payload: { message: "事实" } });
    trace.writeConversationHistory({ durableConversationHistory: [{ id: "m-1", role: "user", parts: [{ type: "text", text: "历史" }] }], runtimeLoadedHistory: { messages: [], loadedCount: 0, truncated: false, limit: 200 } });
    const checkpoint = { messages: [{ role: "user", content: "事实" }] };
    trace.writeIteration(1, { iteration: 1, checkpointBeforeCompaction: checkpoint });
    checkpoint.messages.push({ role: "assistant", content: "后来追加" });
    await trace.flush();
    const run = JSON.parse(await readFile(join(root, "run-1", "run.json"), "utf8")) as Record<string, unknown>;
    const history = JSON.parse(await readFile(join(root, "run-1", "conversation-history.json"), "utf8")) as Record<string, unknown>;
    const iteration = JSON.parse(await readFile(join(root, "run-1", "iterations", "001.json"), "utf8")) as Record<string, unknown>;
    expect(run.schemaVersion).toBe(1);
    expect(history.schemaVersion).toBe(1);
    expect(iteration.schemaVersion).toBe(1);
    expect((iteration.checkpointBeforeCompaction as { messages: unknown[] }).messages).toHaveLength(1);
    expect((await readFile(join(root, "run-1", "trace.ndjson"), "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("keeps run identity/configuration from the first write", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperduck-agent-trace-run-"));
    const trace = new FileAgentExecutionTrace({ rootDir: root, runId: "run-identity" });
    trace.beginRun({ runId: "run-identity", startedAt: "first", provider: "qwen", model: "model-a", maxIterations: 24 });
    trace.updateRun({ startedAt: "second", provider: "unknown", model: undefined, finishedAt: "finished", finalStatus: "completed" });
    await trace.flush();
    const run = JSON.parse(await readFile(join(root, "run-identity", "run.json"), "utf8")) as Record<string, unknown>;
    expect(run.startedAt).toBe("first");
    expect(run.provider).toBe("qwen");
    expect(run.model).toBe("model-a");
    expect(run.finishedAt).toBe("finished");
  });

  it("materializes a resolution appended before the iteration snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperduck-agent-trace-resolution-"));
    const trace = new FileAgentExecutionTrace({ rootDir: root, runId: "run-resolution" });
    trace.appendIterationToolResolution(1, { callId: "call-1", executionSource: "actual_execute", modelFacingContent: "result" });
    await trace.flush();
    trace.writeIteration(1, { iteration: 1, toolResolutions: [], model: { calls: [{ id: "call-1" }] } });
    await trace.flush();
    const iteration = JSON.parse(await readFile(join(root, "run-resolution", "iterations", "001.json"), "utf8")) as { toolResolutions: Array<Record<string, unknown>> };
    expect(iteration.toolResolutions).toHaveLength(1);
    expect(iteration.toolResolutions[0]).toMatchObject({ callId: "call-1", executionSource: "actual_execute" });
  });

  it("merges and deduplicates resolutions across materialization order", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperduck-agent-trace-resolution-merge-"));
    const trace = new FileAgentExecutionTrace({ rootDir: root, runId: "run-resolution-merge" });
    trace.writeIteration(2, { iteration: 2, toolResolutions: [{ callId: "call-1", executionSource: "actual_execute", value: "first" }] });
    await trace.flush();
    trace.appendIterationToolResolution(2, { callId: "call-1", executionSource: "actual_execute", value: "duplicate" });
    trace.appendIterationToolResolution(2, { callId: "call-2", executionSource: "effect_receipt_recovery_after_error", value: "second" });
    await trace.flush();
    trace.writeIteration(2, { iteration: 2, toolResolutions: [] });
    await trace.flush();
    const iteration = JSON.parse(await readFile(join(root, "run-resolution-merge", "iterations", "002.json"), "utf8")) as { toolResolutions: Array<Record<string, unknown>> };
    expect(iteration.toolResolutions).toHaveLength(2);
    expect(iteration.toolResolutions.map((item) => item.callId)).toEqual(["call-1", "call-2"]);
  });

  it("fails open when a trace write rejects", async () => {
    const warn = vi.fn();
    const trace = new FileAgentExecutionTrace({ rootDir: "Z:\\unavailable-paperduck-trace", runId: "run-1", loggerWarn: warn });
    trace.beginRun({ runId: "run-1" });
    trace.record({ type: "run.completed", payload: {} });
    await trace.flush();
    expect(warn).toHaveBeenCalledWith("agent.trace.write_failed", expect.objectContaining({ runId: "run-1" }));
  });

  it("is on only for development by default and can be explicitly enabled in tests", () => {
    expect(isAgentTraceEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isAgentTraceEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(isAgentTraceEnabled({ NODE_ENV: "test", PAPERDUCK_AGENT_TRACE: "full" })).toBe(true);
    expect(isAgentTraceEnabled({ NODE_ENV: "development", PAPERDUCK_AGENT_TRACE: "off" })).toBe(false);
    expect(createFileAgentExecutionTrace("run", { NODE_ENV: "test" })).toBeUndefined();
  });
});
