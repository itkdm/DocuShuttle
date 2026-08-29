import { describe, expect, it } from "vitest";
import { CreateUploadedImageAsset, detectImageMimeType } from "./uploaded-image-asset";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

describe("uploaded image assets", () => {
  it("detects the real image signature and persists only safe metadata", async () => {
    const objects: string[] = [];
    const rows: unknown[] = [];
    const service = new CreateUploadedImageAsset(
      { belongsToOwner: async () => true } as never,
      { put: async (key: string) => { objects.push(key); }, remove: async () => {} } as never,
      { create: async (row: unknown) => { rows.push(row); } },
    );
    expect(detectImageMimeType(png)).toBe("image/png");
    const result = await service.execute({ ownerUserId: "owner", taskId: "task", bytes: png, declaredMimeType: "image/png" });
    expect(result).toEqual({ assetId: expect.any(String), mimeType: "image/png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(objects[0]).toMatch(/^users\/owner\/tasks\/task\/assets\/.*\.png$/);
    expect(rows[0]).toMatchObject({ id: result.assetId, ownerUserId: "owner", taskId: "task", mimeType: "image/png", sha256: result.sha256 });
    expect(JSON.stringify(result)).not.toContain("objectKey");
  });

  it("rejects a browser-spoofed MIME type", async () => {
    const service = new CreateUploadedImageAsset({ belongsToOwner: async () => true } as never, {} as never, {} as never);
    await expect(service.execute({ ownerUserId: "owner", taskId: "task", bytes: png, declaredMimeType: "image/jpeg" })).rejects.toThrow("IMAGE_TYPE_UNSUPPORTED");
  });
});
