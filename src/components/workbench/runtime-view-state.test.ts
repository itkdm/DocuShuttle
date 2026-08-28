import { describe, expect, it } from "vitest";

import { resolveAgentRuntimeView } from "./runtime-view-state";

describe("resolveAgentRuntimeView", () => {
  it.each([
    ["running", false, true, true, false],
    ["awaiting_approval", false, false, true, false],
    ["awaiting_user", true, false, true, false],
    ["completed", true, false, false, true],
    ["failed", true, false, false, true],
    ["cancelled", true, false, false, true],
  ] as const)("derives composer behavior for %s", (status, canSend, canCancel, permissionLocked, isTerminal) => {
    const view = resolveAgentRuntimeView({ checkpoint: { status } });
    expect(view.canSend).toBe(canSend);
    expect(view.canCancel).toBe(canCancel);
    expect(view.permissionLocked).toBe(permissionLocked);
    expect(view.isTerminal).toBe(isTerminal);
  });

  it("prefers checkpoint status over the stale run status", () => {
    const view = resolveAgentRuntimeView({
      run: { id: "run-1", status: "queued", lockVersion: 0, updatedAt: "now" },
      checkpoint: { status: "completed" },
    });
    expect(view.runtimeStatus).toBe("completed");
    expect(view.canSend).toBe(true);
  });

  it("derives queued runs as cancellable and permission-locked", () => {
    const view = resolveAgentRuntimeView({ run: { id: "run-queued", status: "queued", lockVersion: 0, updatedAt: "now" } });
    expect(view.canSend).toBe(false);
    expect(view.canCancel).toBe(true);
    expect(view.permissionLocked).toBe(true);
  });
});
