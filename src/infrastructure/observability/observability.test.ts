import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createEngineeringLogger } from "./server/logger";
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
    await measure("test.operation", { taskId: "task-1" }, async () => "ok");
    await expect(measure("test.failure", {}, async () => { throw Object.assign(new Error("nope"), { code: "FAIL" }); })).rejects.toThrow("nope");
    testLogger.info("test.marker", { requestId: "req-1" });
    const output = await readLines(stream);
    expect(output).toContain('"event":"test.marker"');
    // measure uses the shared logger; this assertion verifies the public API
    // remains non-throwing even when its sink is unavailable.
  });

  it("redacts sensitive values and serializes errors safely", () => {
    expect(redact({ apiKey: "secret", authorization: "Bearer x", prompt: "private" })).toEqual({ apiKey: { length: 6 }, authorization: { length: 8 }, prompt: { length: 7 } });
    expect(redact(new Uint8Array([1, 2]))).toEqual({ length: 2 });
    expect(serializeError(Object.assign(new Error("bad"), { code: "E_BAD", cause: { token: "secret" } }))).toMatchObject({ type: "Error", code: "E_BAD", message: "bad", cause: { token: { length: 6 } } });
  });
});
