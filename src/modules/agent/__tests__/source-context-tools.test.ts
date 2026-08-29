import { describe, expect, it } from "vitest";

import { OoxmlPreservationKernel } from "@/modules/documents";
import { createDocx } from "@/modules/documents/infrastructure/ooxml/__tests__/fixture";
import { createSourceContextTools, type SourceDocumentContextPort, type SourceDocumentDescriptor } from "../application/source-context-tools";

const descriptor = (sourceFileId: string, role: SourceDocumentDescriptor["role"], originalName: string): SourceDocumentDescriptor => ({
  sourceFileId,
  role,
  originalName,
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  byteLength: 1,
  sha256: "a".repeat(64),
  createdAt: "2026-08-26T00:00:00.000Z",
});

describe("source context tools", () => {
  it("keeps template, example and auxiliary sources distinguishable", async () => {
    const template = descriptor("template-1", "template", "template.docx");
    const example = descriptor("example-1", "example", "example.docx");
    const auxiliary = descriptor("aux-1", "auxiliary", "notes.docx");
    const sources: SourceDocumentContextPort = {
      async list() { return [template, example, auxiliary]; },
      async load() { return null; },
    };
    const [list] = createSourceContextTools("task-1", sources, new OoxmlPreservationKernel());

    await expect(list.execute({}, { runId: "run", callId: "call", idempotencyKey: "key", attempt: 1 })).resolves.toEqual({
      documents: [template, example, auxiliary],
    });
    await expect(list.execute({ role: "example" }, { runId: "run", callId: "call", idempotencyKey: "key", attempt: 1 })).resolves.toEqual({ documents: [example] });
  });

  it("reads real OOXML source content with role and stable node IDs, bounded by maxCharacters", async () => {
    const bytes = await createDocx();
    const source = descriptor("example-1", "example", "example.docx");
    const sources: SourceDocumentContextPort = {
      async list() { return [source]; },
      async load(_taskId, sourceFileId) { return sourceFileId === source.sourceFileId ? { descriptor: source, bytes } : null; },
    };
    const [, read] = createSourceContextTools("task-1", sources, new OoxmlPreservationKernel());

    const result = await read.execute({ sourceFileId: source.sourceFileId, maxCharacters: 8 }, { runId: "run", callId: "call", idempotencyKey: "key", attempt: 1 }) as {
      role: string;
      originalName: string;
      summary: { counts: { paragraphs: number } };
      images?: ReadonlyArray<{ nodeId: string; contentType: string; byteLength: number }>;
      regions: ReadonlyArray<{ kind: string; nodeId: string; text: string }>;
    };
    expect(result.role).toBe("example");
    expect(result.originalName).toBe("example.docx");
    expect(result.summary.counts.paragraphs).toBeGreaterThan(0);
    expect(result.regions.reduce((sum, region) => sum + region.text.length, 0)).toBeLessThanOrEqual(8);
    expect(result.regions[0]).toEqual(expect.objectContaining({ kind: "paragraph", nodeId: expect.any(String) }));
    expect(result).toHaveProperty("images.0.nodeId");
    expect(result.images?.[0]).toEqual(expect.objectContaining({ contentType: "image/png", byteLength: expect.any(Number) }));
    expect(result.images?.[0]).not.toHaveProperty("bytes");
  });

  it("returns a typed not-found tool error without touching another source", async () => {
    const sources: SourceDocumentContextPort = { async list() { return []; }, async load() { return null; } };
    const [, read] = createSourceContextTools("task-1", sources, new OoxmlPreservationKernel());
    await expect(read.execute({ sourceFileId: "missing", maxCharacters: 500 }, { runId: "run", callId: "call", idempotencyKey: "key", attempt: 1 })).rejects.toThrow("SOURCE_DOCUMENT_NOT_FOUND");
  });
});
