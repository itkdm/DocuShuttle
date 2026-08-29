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
      { findPreviewByRequest: vi.fn(async () => undefined), createPreview },
    ).execute({ ownerUserId: "owner", taskId: "task", runId: "run-1", interactionId: "interaction-1", callId: "call-1", bytes: png, width: 100, height: 80, revision: "rev-1", pageNumber: 1 });
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
      { findPreviewByRequest: vi.fn(async () => undefined), createPreview: vi.fn(async () => undefined) },
    ).execute({ ownerUserId: "owner", taskId: "task", runId: "run-1", interactionId: "interaction-1", callId: "call-1", bytes: png, width: 100, height: 80, revision: "rev-1" })).rejects.toThrow("DOCUMENT_REVISION_MISMATCH");
    expect(put).not.toHaveBeenCalled();
  });

  it("returns the existing asset for the same rendezvous", async () => {
    const createPreview = vi.fn(async () => undefined);
    const result = await new CreateDocumentPreviewAsset(
      { belongsToOwner: vi.fn(async () => true) } as never,
      { getCurrentRevision: vi.fn(async () => "rev-1") },
      { put: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) } as never,
      { findPreviewByRequest: vi.fn(async () => ({ assetId: "asset-a", sha256: "275f1bcbbb585c71e3b2184304eccfa0e37de92022ca3b6f4e9c10df32318d85", mimeType: "image/png" as const, width: 100, height: 80, revision: "rev-1", pageNumber: 1 })), createPreview },
    ).execute({ ownerUserId: "owner", taskId: "task", runId: "run-1", interactionId: "interaction-1", callId: "call-1", bytes: png, width: 100, height: 80, revision: "rev-1", pageNumber: 1 });
    expect(result.assetId).toBe("asset-a");
    expect(createPreview).not.toHaveBeenCalled();
  });
});
