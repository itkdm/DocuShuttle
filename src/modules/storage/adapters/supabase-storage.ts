import type { SupabaseClient } from "@supabase/supabase-js";

import { assertTaskObjectKey } from "../object-key";
import type { PrivateObjectStoragePort, SignedUpload } from "../ports";
import { measure } from "@/infrastructure/observability";

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
    return measure("storage.upload.sign", { operation: "create_signed_upload", bucket: this.bucket, objectType: "source", mimeType: input.mimeType }, async () => {
      const objectKey = assertTaskObjectKey(input.objectKey);
      const result = await this.client.storage.from(this.bucket).createSignedUploadUrl(objectKey, { upsert: false });
      throwStorageError("Unable to authorize upload", result.error);
      if (!result.data) throw new Error("Unable to authorize upload: no URL returned");

      return { objectKey, method: "PUT", url: result.data.signedUrl, headers: { "content-type": input.mimeType, "cache-control": "no-store" }, expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(), maxBytes: input.maxBytes };
    });
  }

  async createSignedDownload(objectKey: string, expiresInSeconds: number): Promise<string> {
    return measure("storage.download.sign", { operation: "create_signed_download", bucket: this.bucket, objectType: "document" }, async () => {
      const result = await this.client.storage.from(this.bucket).createSignedUrl(assertTaskObjectKey(objectKey), expiresInSeconds, { download: true });
      throwStorageError("Unable to authorize download", result.error);
      if (!result.data) throw new Error("Unable to authorize download: no URL returned");
      return result.data.signedUrl;
    });
  }

  async put(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    return measure("storage.upload", { operation: "upload", bucket: this.bucket, objectType: "document", bytes: bytes.length, mimeType }, async () => {
      const result = await this.client.storage.from(this.bucket).upload(assertTaskObjectKey(objectKey), bytes, { contentType: mimeType, cacheControl: "no-store", upsert: false });
      throwStorageError("Unable to store object", result.error);
    });
  }

  async get(objectKey: string): Promise<Uint8Array> {
    return measure("storage.download", { operation: "download", bucket: this.bucket, objectType: "document" }, async () => {
      const result = await this.client.storage.from(this.bucket).download(assertTaskObjectKey(objectKey));
      throwStorageError("Unable to read object", result.error);
      if (!result.data) throw new Error("Unable to read object: no body returned");
      return new Uint8Array(await result.data.arrayBuffer());
    });
  }

  async remove(objectKey: string): Promise<void> {
    return measure("storage.remove", { operation: "remove", bucket: this.bucket, objectType: "document" }, async () => {
      const result = await this.client.storage.from(this.bucket).remove([assertTaskObjectKey(objectKey)]);
      throwStorageError("Unable to remove object", result.error);
    });
  }
}
