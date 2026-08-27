import { describe, expect, it } from "vitest";

import { compactAgentMessages } from "../application/context-compaction";
import type { AgentLoopMessage } from "../application/loop";

const policy = { maxCharacters: 300, maxMessages: 8, keepRecentUnits: 2, maxUserSummaryCharacters: 80 };

describe("agent context compaction", () => {
  it("keeps tool calls paired with their results and summarizes document evidence", () => {
    const messages: AgentLoopMessage[] = [
      { role: "user", content: "把实验重点改得更清楚" },
      { role: "assistant", content: "", toolCalls: [{ id: "inspect-1", name: "inspect_document", input: {} }] },
      { role: "tool", content: JSON.stringify({ revision: "rev-1", nodeId: "p-1", counts: { paragraphs: 2 } }), toolCallId: "inspect-1", toolName: "inspect_document" },
      { role: "assistant", content: "我已定位到目标位置。" },
      { role: "user", content: "并保留原有格式" },
      { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "read_document_region", input: { nodeId: "p-1" } }] },
      { role: "tool", content: JSON.stringify({ revision: "rev-1", nodeId: "p-1", text: "实验重点" }), toolCallId: "read-1", toolName: "read_document_region" },
      { role: "assistant", content: "现在可以继续。" },
    ];
    const result = compactAgentMessages(messages, policy);
    expect(result.compacted).toBe(true);
    const retainedCalls = result.messages.flatMap((message) => message.toolCalls ?? []);
    for (const call of retainedCalls) {
      expect(result.messages.some((message) => message.role === "tool" && message.toolCallId === call.id)).toBe(true);
    }
    expect(result.messages.some((message) => message.content.includes("rev-1"))).toBe(true);
    expect(result.messages.some((message) => message.content.includes("实验重点"))).toBe(true);
  });

  it("does not compact a short conversation", () => {
    const messages: AgentLoopMessage[] = [{ role: "user", content: "你好" }, { role: "assistant", content: "你好，我可以帮你处理 Word 文档。" }];
    const result = compactAgentMessages(messages, policy);
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("reduces oversized recent tool payloads without breaking JSON", () => {
    const result = compactAgentMessages([
      { role: "user", content: "分析文档" },
      { role: "assistant", content: "", toolCalls: [{ id: "large-1", name: "inspect_document", input: {} }] },
      { role: "tool", content: JSON.stringify({ revision: "rev-9", nodeId: "p-9", text: "x".repeat(20_000) }), toolCallId: "large-1", toolName: "inspect_document" },
    ], { ...policy, maxCharacters: 200 });
    const tool = result.messages.find((message) => message.role === "tool");
    expect(tool).toBeDefined();
    expect(JSON.parse(tool!.content)).toMatchObject({ revision: "rev-9", nodeId: "p-9" });
    expect(tool!.content.length).toBeLessThan(2_000);
  });

  it("never exceeds either hard provider budget, even with oversized metadata", () => {
    const result = compactAgentMessages([
      { role: "system", content: "系统约束".repeat(40) },
      { role: "user", content: "用户目标".repeat(40) },
      { role: "assistant", content: "", toolCalls: [{ id: "call-large", name: "inspect_document", input: { query: "x".repeat(500) } }] },
      { role: "tool", content: JSON.stringify({ summary: "结果", revision: "r1", text: "y".repeat(2_000) }), toolCallId: "call-large", toolName: "inspect_document" },
      { role: "assistant", content: "最终判断".repeat(40) },
    ], { maxCharacters: 180, maxMessages: 4, keepRecentUnits: 3, maxUserSummaryCharacters: 30 });
    expect(result.messages.length).toBeLessThanOrEqual(4);
    expect(result.messages.reduce((sum, message) => sum + message.content.length + (message.toolCallId?.length ?? 0) + (message.toolName?.length ?? 0) + (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0), 0)).toBeLessThanOrEqual(180);
    for (const call of result.messages.flatMap((message) => message.toolCalls ?? [])) {
      expect(result.messages.some((message) => message.role === "tool" && message.toolCallId === call.id)).toBe(true);
    }
  });
});
