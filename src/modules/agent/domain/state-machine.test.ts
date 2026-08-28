import { describe, expect, it } from "vitest";

import type { AgentRunStatus } from "./model";
import { canTransition, isTerminalStatus } from "./state-machine";

describe("Agent runtime lifecycle", () => {
  it("contains only runtime execution and HITL statuses", () => {
    const statuses = [
      "queued",
      "running",
      "awaiting_approval",
      "awaiting_user",
      "completed",
      "failed",
      "cancelled",
    ] satisfies AgentRunStatus[];

    const removedStatus = ["awaiting", "review"].join("_") as AgentRunStatus;
    expect(statuses).not.toContain(removedStatus);
  });

  it("does not transition running into a post-write review state", () => {
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("running", "awaiting_approval")).toBe(true);
    expect(canTransition("running", "awaiting_user")).toBe(true);
    expect(canTransition("completed", "running")).toBe(false);
  });

  it("treats a successful write as a terminal completed run", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("awaiting_approval")).toBe(false);
    expect(isTerminalStatus("awaiting_user")).toBe(false);
  });
});
