import { describe, expect, it } from "vitest";

import type { AgentEvent } from "@/modules/agent/application/events";
import { reduceAgentEvents } from "./agent-turn-reducer";

const event = (payload: AgentEvent): AgentEvent => payload;

describe("agent turn tool validation presentation", () => {
  it("keeps structured validation details while showing a concise failure summary", () => {
    const validation = { error: "TOOL_INPUT_VALIDATION_FAILED", issues: [{ path: "limit", code: "too_big", message: "Too big: expected number to be <=80", maximum: 80 }] };
    const state = reduceAgentEvents([event({ eventId: "failed-1", runId: "run-1", timestamp: "2026-01-01T00:00:00.000Z", type: "tool.failed", callId: "call-1", name: "list_document_regions", error: JSON.stringify(validation) })], "run-1");
    expect(state.activities[0]).toMatchObject({ type: "tool", state: "failed", error: "参数不符合要求", errorDetails: validation });
  });
});
