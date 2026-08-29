import { describe, expect, it } from "vitest";
import { createApprovalSubmissionGate } from "./approval-submission-gate";

describe("approval submission gate", () => {
  it("allows one approval request and rejects all competing choices until release", () => {
    const gate = createApprovalSubmissionGate();
    expect(gate.claim("run:interaction:call")).toBe(true);
    expect(gate.claim("run:interaction:call")).toBe(false);
    expect(gate.claim("run:interaction:other-call")).toBe(false);
    gate.release("run:interaction:other-call");
    expect(gate.claim("run:interaction:call")).toBe(false);
    gate.release("run:interaction:call");
    expect(gate.claim("run:interaction:other-call")).toBe(true);
  });
});
