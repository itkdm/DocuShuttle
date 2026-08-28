export type SignedUpload = {
  objectKey: string;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
};

export interface PrivateObjectStoragePort {
  createSignedUpload(input: {
    objectKey: string;
    mimeType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<SignedUpload>;
  createSignedDownload(objectKey: string, expiresInSeconds: number): Promise<string>;
  put(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  ensureObject?(objectKey: string, expectedBytes: Uint8Array, mimeType: string): Promise<{ created: boolean }>;
  get(objectKey: string): Promise<Uint8Array>;
  remove(objectKey: string): Promise<void>;
}

export class InvalidObjectKeyError extends Error {
  readonly code = "INVALID_OBJECT_KEY";
}
