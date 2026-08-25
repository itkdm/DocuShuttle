import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { SupabaseStorageAdapter } from "./supabase-storage";

const objectKey = "users/user-1/tasks/task-1/sources/source.docx";

function createClient() {
  const bucket = {
    createSignedUploadUrl: vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.example/upload?token=signed" },
      error: null,
    }),
    createSignedUrl: vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.example/download?token=signed" },
      error: null,
    }),
    upload: vi.fn().mockResolvedValue({ data: { path: objectKey }, error: null }),
    download: vi.fn().mockResolvedValue({
      data: new Blob([new Uint8Array([1, 2, 3])]),
      error: null,
    }),
    remove: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
  return {
    client: { storage: { from: vi.fn(() => bucket) } } as unknown as SupabaseClient,
    bucket,
  };
}

describe("SupabaseStorageAdapter", () => {
  it("creates private signed transfer URLs without exposing a service credential", async () => {
    const { client, bucket } = createClient();
    const storage = new SupabaseStorageAdapter(client);
    const upload = await storage.createSignedUpload({
      objectKey,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      maxBytes: 20 * 1024 * 1024,
      expiresInSeconds: 600,
    });
    const download = await storage.createSignedDownload(objectKey, 60);

    expect(upload.url).toContain("token=signed");
    expect(download).toContain("token=signed");
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(objectKey, { upsert: false });
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(objectKey, 60, { download: true });
  });

  it("round-trips and deletes an object through the authenticated bucket client", async () => {
    const { client, bucket } = createClient();
    const storage = new SupabaseStorageAdapter(client);
    await storage.put(objectKey, new Uint8Array([1, 2, 3]), "application/json");
    expect(await storage.get(objectKey)).toEqual(new Uint8Array([1, 2, 3]));
    await storage.remove(objectKey);

    expect(bucket.upload).toHaveBeenCalledOnce();
    expect(bucket.download).toHaveBeenCalledWith(objectKey);
    expect(bucket.remove).toHaveBeenCalledWith([objectKey]);
  });
});
