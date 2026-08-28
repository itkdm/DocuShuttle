import { describe, expect, it } from "vitest";

import { PAPERDUCK_AGENT_SYSTEM } from "./openai-compatible-model";

describe("PaperDuck Fresh Run intent contract", () => {
  it("makes the latest Fresh Run user intent authoritative", () => {
    expect(PAPERDUCK_AGENT_SYSTEM).toContain("Fresh Run 规则");
    expect(PAPERDUCK_AGENT_SYSTEM).toContain("不得自动重启旧的写入、工具或审批流程");
    expect(PAPERDUCK_AGENT_SYSTEM).toContain("same-Run");
  });
});
