import type { SupabaseClient } from "@supabase/supabase-js";

import { assertTaskObjectKey } from "../object-key";
import type { PrivateObjectStoragePort, SignedUpload } from "../ports";

export const PAPERDUCK_STORAGE_BUCKET = "paperduck-private";

const throwStorageError = (context: string, error: { message: string } | null) => {
  if (error) throw new Error(`${context}: ${error.message}`);
};

export class SupabaseStorageAdapter implements PrivateObjectStoragePort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly bucket = PAPERDUCK_STORAGE_BUCKET,
  ) {}

  async createSignedUpload(input: {
    objectKey: string;
    mimeType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<SignedUpload> {
    const objectKey = assertTaskObjectKey(input.objectKey);
    const result = await this.client.storage
      .from(this.bucket)
      .createSignedUploadUrl(objectKey, { upsert: false });
    throwStorageError("Unable to authorize upload", result.error);
    if (!result.data) throw new Error("Unable to authorize upload: no URL returned");

    // Supabase signed upload URLs currently have a fixed two-hour lifetime.
    return {
      objectKey,
      method: "PUT",
      url: result.data.signedUrl,
      headers: { "content-type": input.mimeType, "cache-control": "no-store" },
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
      maxBytes: input.maxBytes,
    };
  }

  async createSignedDownload(objectKey: string, expiresInSeconds: number): Promise<string> {
    const result = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(assertTaskObjectKey(objectKey), expiresInSeconds, { download: true });
    throwStorageError("Unable to authorize download", result.error);
    if (!result.data) throw new Error("Unable to authorize download: no URL returned");
    return result.data.signedUrl;
  }

  async put(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const result = await this.client.storage
      .from(this.bucket)
      .upload(assertTaskObjectKey(objectKey), bytes, {
        contentType: mimeType,
        cacheControl: "no-store",
        upsert: false,
      });
    throwStorageError("Unable to store object", result.error);
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const result = await this.client.storage
      .from(this.bucket)
      .download(assertTaskObjectKey(objectKey));
    throwStorageError("Unable to read object", result.error);
    if (!result.data) throw new Error("Unable to read object: no body returned");
    return new Uint8Array(await result.data.arrayBuffer());
  }

  async remove(objectKey: string): Promise<void> {
    const result = await this.client.storage
      .from(this.bucket)
      .remove([assertTaskObjectKey(objectKey)]);
    throwStorageError("Unable to remove object", result.error);
  }
}
