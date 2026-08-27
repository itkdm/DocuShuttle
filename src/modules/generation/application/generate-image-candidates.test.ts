import { describe, expect, it, vi } from "vitest";

import type { GeneratedImage } from "../domain";
import type { ImageGenerationPort as ImageGenerationPortType } from "../ports";
import { GenerateImageCandidates, RemoteImageFetcher, type GeneratedAssetStorePort, type RemoteImageFetcherPort } from "./generate-image-candidates";
import type { TaskRepositoryPort } from "@/modules/tasks/ports";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";

const taskRepository = (belongs = true): TaskRepositoryPort => ({
  create: vi.fn(),
  listByOwner: vi.fn().mockResolvedValue([]),
  getWorkspace: vi.fn(),
  belongsToOwner: vi.fn().mockResolvedValue(belongs),
  registerSource: vi.fn(),
});

const storage = () => {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    createSignedUpload: vi.fn(),
    createSignedDownload: vi.fn(async (key: string) => `https://signed.example/${encodeURIComponent(key)}`),
    put: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); }),
    get: vi.fn(),
    remove: vi.fn(async (key: string) => { objects.delete(key); }),
  } as unknown as PrivateObjectStoragePort & { objects: Map<string, Uint8Array> };
};

const assetStore = () => ({
  create: vi.fn(async ({ id }: { id: string }) => ({ id })),
}) as unknown as GeneratedAssetStorePort;

const provider = (images: GeneratedImage[]): ImageGenerationPortType => ({
  generate: vi.fn().mockResolvedValue(images),
});

describe("GenerateImageCandidates", () => {
  it("persists provider bytes and returns signed candidate DTOs without provider credentials", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const assets = assetStore();
    const result = await new GenerateImageCandidates(
      taskRepository(),
      provider([{ mimeType: "image/png", bytes, providerRequestId: "provider-task-1" }]),
      storage(),
      assets,
      {} as RemoteImageFetcherPort,
    ).execute({ ownerUserId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", prompt: "A paper duck", targetNodeId: "node_abc" });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      taskId: "22222222-2222-4222-8222-222222222222",
      targetNodeId: "node_abc",
      mimeType: "image/png",
      provider: "apimart",
      providerRequestId: "provider-task-1",
    });
    expect(JSON.stringify(result)).not.toContain("apiKey");
    expect(JSON.stringify(result)).not.toContain("Bearer");
    expect(assets.create).toHaveBeenCalledOnce();
  });

  it("downloads HTTPS provider candidates and rejects insecure or unsupported responses", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "image/webp" } }));
    const fetcher = new RemoteImageFetcher(request);
    await expect(fetcher.fetch("https://cdn.example/image.webp")).resolves.toEqual({ bytes: new Uint8Array([1, 2]), mimeType: "image/webp" });
    await expect(fetcher.fetch("http://cdn.example/image.webp")).rejects.toThrow("insecure");
    await expect(fetcher.fetch("https://127.0.0.1/image.webp")).rejects.toThrow("private");
  });

  it("does not leave an orphaned object when asset persistence fails", async () => {
    const objectStorage = storage();
    const assets = { create: vi.fn().mockRejectedValue(new Error("database down")) } as unknown as GeneratedAssetStorePort;
    await expect(new GenerateImageCandidates(
      taskRepository(),
      provider([{ mimeType: "image/jpeg", bytes: new Uint8Array([1]) }]),
      objectStorage,
      assets,
      {} as RemoteImageFetcherPort,
    ).execute({ ownerUserId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", prompt: "x" })).rejects.toThrow("database down");
    expect(objectStorage.remove).toHaveBeenCalledOnce();
  });
});
