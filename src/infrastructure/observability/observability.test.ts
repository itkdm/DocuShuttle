import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createEngineeringLogger, slowThresholds } from "./server/logger";
import { withLogContext, getLogContext } from "./server/context";
import { measure } from "./server/timing";
import { redact, serializeError } from "./server/redaction";

const readLines = async (stream: PassThrough) => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return stream.read()?.toString() ?? "";
};

describe("engineering observability", () => {
  it("isolates async contexts and enriches nested context", async () => {
    const results = await Promise.all([
      withLogContext({ requestId: "a" }, async () => {
        await Promise.resolve();
        const nested = await withLogContext({ runId: "run-a" }, async () => getLogContext());
        return { outer: getLogContext(), nested };
      }),
      withLogContext({ requestId: "b" }, async () => getLogContext()),
    ]);
    expect(results[0]).toEqual({ outer: { requestId: "a" }, nested: { requestId: "a", runId: "run-a" } });
    expect(results[1]).toEqual({ requestId: "b" });
    expect(getLogContext()).toEqual({});
  });

  it("records completed and failed measurements with duration", async () => {
    const stream = new PassThrough();
    const testLogger = createEngineeringLogger({ profile: "test", stream });
    await measure("test.operation", { taskId: "task-1" }, async () => "ok", testLogger);
    await expect(measure("test.failure", {}, async () => { throw Object.assign(new Error("nope"), { code: "FAIL" }); }, testLogger)).rejects.toThrow("nope");
    testLogger.info("test.marker", { requestId: "req-1" });
    const output = await readLines(stream);
    expect(output).toContain('"event":"test.marker"');
    expect(output).toContain('"event":"test.operation.completed"');
    expect(output).toContain('"durationMs":');
  });

  it("promotes operations that cross their centralized slow threshold", async () => {
    const stream = new PassThrough();
    const testLogger = createEngineeringLogger({ profile: "test", stream });
    slowThresholds["test.operation"] = 0;
    await measure("test.operation", {}, async () => "ok", testLogger);
    const output = await readLines(stream);
    expect(output).toContain('"slow":true');
    expect(output).toContain('"event":"test.operation.slow"');
    delete slowThresholds["test.operation"];
  });

  it("does not create a local file for the production profile", () => {
    const directory = path.join(process.cwd(), ".paperduck", "logs");
    const before = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    createEngineeringLogger({ profile: "production", stream: new PassThrough() });
    const after = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    expect(after).toEqual(before);
  });

  it("redacts sensitive values and serializes errors safely", () => {
    expect(redact({ apiKey: "secret", authorization: "Bearer x", prompt: "private" })).toEqual({ apiKey: { length: 6 }, authorization: { length: 8 }, prompt: { length: 7 } });
    expect(redact(new Uint8Array([1, 2]))).toEqual({ length: 2 });
    expect(serializeError(Object.assign(new Error("bad"), { code: "E_BAD", cause: { token: "secret" } }))).toMatchObject({ type: "Error", code: "E_BAD", message: "bad", cause: { token: { length: 6 } } });
  });
});
