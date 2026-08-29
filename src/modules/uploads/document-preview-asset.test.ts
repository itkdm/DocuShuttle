import { describe, expect, it, vi } from "vitest";
import { CreateDocumentPreviewAsset } from "./document-preview-asset";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

describe("document preview assets", () => {
  it("validates the current revision and persists a private PNG asset", async () => {
    const put = vi.fn(async () => undefined);
    const createPreview = vi.fn(async () => undefined);
    const result = await new CreateDocumentPreviewAsset(
      { belongsToOwner: vi.fn(async () => true) } as never,
      { getCurrentRevision: vi.fn(async () => "rev-1") },
      { put, remove: vi.fn(async () => undefined) } as never,
      { createPreview },
    ).execute({ ownerUserId: "owner", taskId: "task", bytes: png, width: 100, height: 80, revision: "rev-1", pageNumber: 1 });
    expect(result).toMatchObject({ mimeType: "image/png", revision: "rev-1", pageNumber: 1, width: 100, height: 80 });
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^users\/owner\/tasks\/task\/assets\/.*\.png$/), png, "image/png");
    expect(createPreview).toHaveBeenCalledWith(expect.objectContaining({ width: 100, height: 80, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }));
  });

  it("rejects a stale rendered revision before writing storage", async () => {
    const put = vi.fn(async () => undefined);
    await expect(new CreateDocumentPreviewAsset(
      { belongsToOwner: vi.fn(async () => true) } as never,
      { getCurrentRevision: vi.fn(async () => "rev-2") },
      { put, remove: vi.fn(async () => undefined) } as never,
      { createPreview: vi.fn(async () => undefined) },
    ).execute({ ownerUserId: "owner", taskId: "task", bytes: png, width: 100, height: 80, revision: "rev-1" })).rejects.toThrow("DOCUMENT_REVISION_MISMATCH");
    expect(put).not.toHaveBeenCalled();
  });
});
