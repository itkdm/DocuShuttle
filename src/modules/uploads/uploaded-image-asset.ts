import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import { buildTaskObjectKey } from "@/modules/storage/object-key";
import type { TaskRepositoryPort } from "@/modules/tasks/ports";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type UploadedImageMimeType = typeof IMAGE_MIME_TYPES[number];
export const MAX_UPLOADED_IMAGE_BYTES = 20 * 1024 * 1024;

const matches = (bytes: Uint8Array, signature: readonly number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);

export function detectImageMimeType(bytes: Uint8Array): UploadedImageMimeType | undefined {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (matches(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return undefined;
}

const sha256 = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export interface UploadedImageAssetStore {
  create(input: { id: string; ownerUserId: string; taskId: string; objectKey: string; mimeType: UploadedImageMimeType; sha256: string }): Promise<void>;
}

export class CreateUploadedImageAsset {
  constructor(private readonly tasks: TaskRepositoryPort, private readonly storage: PrivateObjectStoragePort, private readonly assets: UploadedImageAssetStore) {}

  async execute(input: { ownerUserId: string; taskId: string; bytes: Uint8Array; declaredMimeType?: string }) {
    if (!(await this.tasks.belongsToOwner(input.taskId, input.ownerUserId))) throw new Error("TASK_NOT_FOUND");
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_UPLOADED_IMAGE_BYTES) throw new Error("IMAGE_SIZE_OUT_OF_RANGE");
    const mimeType = detectImageMimeType(input.bytes);
    if (!mimeType || (input.declaredMimeType && input.declaredMimeType !== mimeType)) throw new Error("IMAGE_TYPE_UNSUPPORTED");
    const assetId = crypto.randomUUID();
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
    const objectKey = buildTaskObjectKey({ userId: input.ownerUserId, taskId: input.taskId, category: "assets", fileName: `${assetId}.${extension}` });
    const digest = await sha256(input.bytes);
    await this.storage.put(objectKey, input.bytes, mimeType);
    try {
      await this.assets.create({ id: assetId, ownerUserId: input.ownerUserId, taskId: input.taskId, objectKey, mimeType, sha256: digest });
    } catch (error) {
      await this.storage.remove(objectKey).catch(() => undefined);
      throw error;
    }
    return { assetId, mimeType, sha256: digest };
  }
}
