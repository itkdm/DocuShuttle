import { describe, expect, it, vi } from "vitest";

import {
  createDocumentVersionTools,
  type DocumentVersionAccessPort,
} from "../application/document-version-tools";

const versions: DocumentVersionAccessPort = {
  list: vi.fn(async () => ({
    currentVersionId: "v2",
    versions: [
      {
        id: "v2",
        number: 2,
        origin: "agent" as const,
        revision: "sha-v2",
        createdAt: "2026-08-26T00:00:00.000Z",
      },
      {
        id: "v1",
        number: 1,
        origin: "import" as const,
        revision: "sha-v1",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    ],
  })),
  exportCurrent: vi.fn(async () => ({
    exportId: "export-1",
    versionId: "v2",
    versionNumber: 2,
    revision: "sha-v2",
    downloadUrl: "https://storage.test/export.docx",
  })),
  restore: vi.fn(async ({ versionId }) => ({
    versionId: "v3",
    versionNumber: 3,
    revision: `restored-from-${versionId}`,
  })),
};

describe("document version Agent tools", () => {
  it("exposes read-only version listing and export through provider-neutral ports", async () => {
    const tools = createDocumentVersionTools(versions);
    const list = tools.find((tool) => tool.name === "list_document_versions");
    const exportTool = tools.find((tool) => tool.name === "export_document");

    expect(list?.requiresApproval).toBeFalsy();
    expect(await list?.execute({}, { runId: "r", callId: "c1", idempotencyKey: "k1", attempt: 1 })).toMatchObject({ currentVersionId: "v2" });
    expect(await exportTool?.execute({}, { runId: "r", callId: "c2", idempotencyKey: "k2", attempt: 2 })).toMatchObject({ versionId: "v2", downloadUrl: expect.any(String) });
    expect(versions.list).toHaveBeenCalledOnce();
    expect(versions.exportCurrent).toHaveBeenCalledOnce();
  });

  it("marks restore as an approval-gated operation and validates its input", async () => {
    const tools = createDocumentVersionTools(versions);
    const restore = tools.find((tool) => tool.name === "restore_document_version");
    expect(restore?.requiresApproval).toBe(true);
    expect(() => restore?.inputSchema.parse({})).toThrow();
    expect(await restore?.execute(
      { versionId: "v1", expectedRevision: "sha-v2" },
      { runId: "r", callId: "c3", idempotencyKey: "k3", attempt: 3 },
    )).toMatchObject({ versionId: "v3" });
    expect(versions.restore).toHaveBeenCalledWith({ versionId: "v1", expectedRevision: "sha-v2" });
  });
});
