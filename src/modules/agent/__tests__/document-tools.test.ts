import { describe, expect, it } from "vitest";

import { OoxmlPreservationKernel } from "@/modules/documents";
import { createDocx } from "@/modules/documents/infrastructure/ooxml/__tests__/fixture";
import { createDocumentTools } from "../application/document-tools";

describe("document mutation planning tool", () => {
  it("returns a semantic dry-run without changing the working document", async () => {
    const source = await createDocx();
    const documents = new OoxmlPreservationKernel();
    const inspection = await documents.inspect(source);
    const target = inspection.paragraphs.find(({ text }) => text === "Hello duck");
    expect(target).toBeDefined();
    if (!target) return;
    const revision = inspection.manifest.revision;
    let committed = false;
    const tools = createDocumentTools(documents, {
      async load() { return { bytes: source, revision }; },
      async commit() { committed = true; return { revision }; },
    });
    const plan = tools.find((tool) => tool.name === "plan_text_change");
    expect(plan).toBeDefined();
    if (!plan) return;
    const result = await plan.execute({
      nodeId: target.address.nodeId,
      expectedRevision: revision,
      expectedText: target.text,
      replacement: "Hello PaperDuck",
    }, { runId: "run", callId: "call", idempotencyKey: "key", attempt: 1 });
    expect(result).toMatchObject({ baseRevision: revision, riskLevel: "low", targets: [target.address.nodeId] });
    expect(result).toHaveProperty("operations.0.nodeId", target.address.nodeId);
    expect(result).not.toHaveProperty("operations.0.address");
    expect(result).not.toHaveProperty("changedParts");
    expect(committed).toBe(false);
  });
});
