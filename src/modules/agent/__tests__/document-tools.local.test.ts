import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OoxmlPreservationKernel } from "@/modules/documents";
import { AgentLoopRunner, type AgentLoopCheckpoint, type AgentModelPort } from "../application/loop";
import { createDocumentTools } from "../application/document-tools";

const fixturePath = process.env.PAPERDUCK_PRIVATE_DOCX_FIXTURES?.split(path.delimiter).map((value) => value.trim()).find(Boolean);

class MemoryStore {
  private checkpoint?: AgentLoopCheckpoint;
  async load() { return this.checkpoint; }
  async save(_runId: string, checkpoint: AgentLoopCheckpoint) { this.checkpoint = structuredClone(checkpoint); }
}

describe.skipIf(!fixturePath)("Agent document tools against a real DOCX", () => {
  it("inspects, requests approval, applies one change, validates and reopens", async () => {
    const source = Uint8Array.from(await readFile(fixturePath!));
    const engine = new OoxmlPreservationKernel();
    let current = source;
    let revision = (await engine.inspect(source)).manifest.revision;
    const working = {
      async load() { return { bytes: current, revision }; },
      async commit(input: { expectedRevision: string; bytes: Uint8Array; revision: string; changedEntries: readonly string[] }) {
        expect(input.expectedRevision).toBe(revision);
        current = input.bytes as Uint8Array<ArrayBuffer>;
        revision = input.revision;
        return { revision };
      },
    };
    const tools = createDocumentTools(engine, working);
    const inspection = await engine.inspect(source);
    const target = inspection.tableCells.find(({ text }) => text.trim().length > 0);
    expect(target).toBeDefined();
    if (!target) return;
    const replacement = `${target.text}（Agent Loop 验证）`;
    let phase = 0;
    const model: AgentModelPort = {
      async decide() {
        if (phase++ === 0) return { kind: "tool_calls", calls: [{ id: "inspect", name: "inspect_document", input: {} }] };
        if (phase === 2) return { kind: "tool_calls", calls: [{ id: "apply", name: "apply_text_change", input: { nodeId: target.address.nodeId, expectedRevision: revision, expectedText: target.text, replacement } }] };
        if (phase === 1) return { kind: "tool_calls", calls: [{ id: "read", name: "read_document_region", input: { nodeId: target.address.nodeId } }] };
        return { kind: "message", text: "已完成修改并通过 DOCX 重开校验。" };
      },
    };
    const runner = new AgentLoopRunner(model, new MemoryStore(), tools);
    const paused = await runner.run("local-real-docx", "把目标区域补充标记，先检查文档再修改");
    expect(paused.checkpoint.status).toBe("awaiting_user");
    expect(paused.events.some((event) => event.type === "approval.required")).toBe(true);
    const completed = await runner.resume("local-real-docx", "approved");
    expect(completed.checkpoint.status).toBe("completed");
    const reopened = await engine.validate(current);
    expect(reopened.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(reopened.tableCells.some(({ text }) => text.includes("Agent Loop 验证"))).toBe(true);
  });
});
