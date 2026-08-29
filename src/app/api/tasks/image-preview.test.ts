import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(), assetLoad: vi.fn(), storageGet: vi.fn(), snapshotLoad: vi.fn(), readImage: vi.fn(),
}));

vi.mock("@/infrastructure/supabase/server", () => ({ requireSupabaseIdentity: mocks.identity }));
vi.mock("@/modules/generation/infrastructure/supabase-generated-asset-store", () => ({ SupabaseGeneratedAssetStore: class { load = mocks.assetLoad; } }));
vi.mock("@/modules/generation/infrastructure/supabase-image-application", () => ({ SupabaseWorkingDocumentSnapshot: class { load = mocks.snapshotLoad; } }));
vi.mock("@/modules/storage/adapters/supabase-storage", () => ({ SupabaseStorageAdapter: class { get = mocks.storageGet; } }));
vi.mock("@/modules/documents/infrastructure/ooxml/ooxml-preservation-kernel", () => ({ OoxmlPreservationKernel: class { readImage = mocks.readImage; } }));

import { GET as getAsset } from "./[taskId]/images/[assetId]/route";
import { GET as getWorking } from "./[taskId]/document/images/[nodeId]/route";

describe("authenticated image previews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identity.mockResolvedValue({ client: {}, userId: "owner-1" });
    mocks.storageGet.mockResolvedValue(Uint8Array.from([1, 2, 3]));
  });

  it("scopes generated assets to the authenticated owner, task and kind", async () => {
    mocks.assetLoad.mockImplementation(async (input: unknown) => { expect(input).toEqual({ assetId: "asset-1", taskId: "task-1", ownerUserId: "owner-1" }); return { objectKey: "users/owner-1/tasks/task-1/assets/a.png", mimeType: "image/png" }; });
    const response = await getAsset(new Request("http://localhost/api/tasks/task-1/images/asset-1"), { params: Promise.resolve({ taskId: "task-1", assetId: "asset-1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private");
    expect(await response.arrayBuffer()).toEqual(Uint8Array.from([1, 2, 3]).buffer);
  });

  it("does not serve unsupported or missing generated assets", async () => {
    mocks.assetLoad.mockResolvedValue({ objectKey: "private/key", mimeType: "image/gif" });
    expect((await getAsset(new Request("http://localhost"), { params: Promise.resolve({ taskId: "task-1", assetId: "asset-1" }) })).status).toBe(404);
    mocks.assetLoad.mockResolvedValue(null);
    expect((await getAsset(new Request("http://localhost"), { params: Promise.resolve({ taskId: "task-1", assetId: "asset-1" }) })).status).toBe(404);
  });

  it("rejects stale working previews before reading document bytes", async () => {
    mocks.snapshotLoad.mockResolvedValue({ objectKey: "users/owner-1/tasks/task-1/versions/current.docx", revision: "rev-2" });
    const response = await getWorking(new Request("http://localhost/api/tasks/task-1/document/images/node-1?revision=rev-1"), { params: Promise.resolve({ taskId: "task-1", nodeId: "node-1" }) });
    expect(response.status).toBe(409);
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it("returns a private no-store working image for the owned current revision", async () => {
    mocks.snapshotLoad.mockResolvedValue({ objectKey: "users/owner-1/tasks/task-1/versions/current.docx", revision: "rev-2" });
    mocks.readImage.mockResolvedValue({ contentType: "image/webp", bytes: Uint8Array.from([4, 5]) });
    const response = await getWorking(new Request("http://localhost/api/tasks/task-1/document/images/node-1?revision=rev-2"), { params: Promise.resolve({ taskId: "task-1", nodeId: "node-1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/webp");
  });
});

