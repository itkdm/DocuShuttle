import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import { buildTaskObjectKey } from "@/modules/storage/object-key";
import type { TaskRepositoryPort } from "@/modules/tasks/ports";

export const MAX_DOCUMENT_PREVIEW_BYTES = 10 * 1024 * 1024;

const isPng = (bytes: Uint8Array) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
const sha256 = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
};

export interface DocumentPreviewAssetStore {
  findPreviewByRequest(input: { ownerUserId: string; taskId: string; providerRequestId: string }): Promise<{ assetId: string; sha256: string; mimeType: "image/png"; width: number; height: number; revision: string; pageNumber?: number } | undefined>;
  createPreview(input: { id: string; ownerUserId: string; taskId: string; objectKey: string; sha256: string; width: number; height: number; revision: string; pageNumber?: number; providerRequestId: string }): Promise<void>;
}

export interface CurrentDocumentRevisionPort {
  getCurrentRevision(taskId: string, ownerUserId: string): Promise<string | undefined>;
}

export class CreateDocumentPreviewAsset {
  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly documents: CurrentDocumentRevisionPort,
    private readonly storage: PrivateObjectStoragePort,
    private readonly assets: DocumentPreviewAssetStore,
  ) {}

  async execute(input: { ownerUserId: string; taskId: string; runId: string; interactionId: string; callId: string; bytes: Uint8Array; width: number; height: number; revision: string; pageNumber?: number }) {
    if (!(await this.tasks.belongsToOwner(input.taskId, input.ownerUserId))) throw new Error("TASK_NOT_FOUND");
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_DOCUMENT_PREVIEW_BYTES) throw new Error("PREVIEW_SIZE_OUT_OF_RANGE");
    if (!isPng(input.bytes)) throw new Error("PREVIEW_TYPE_UNSUPPORTED");
    if (!Number.isInteger(input.width) || input.width < 1 || input.width > 10_000 || !Number.isInteger(input.height) || input.height < 1 || input.height > 10_000) throw new Error("PREVIEW_DIMENSION_INVALID");
    if (!input.revision || input.revision !== await this.documents.getCurrentRevision(input.taskId, input.ownerUserId)) throw new Error("DOCUMENT_REVISION_MISMATCH");
    const digest = await sha256(input.bytes);
    const providerRequestId = `${input.runId}:${input.interactionId}:${input.callId}`;
    const existing = await this.assets.findPreviewByRequest({ ownerUserId: input.ownerUserId, taskId: input.taskId, providerRequestId });
    if (existing) {
      if (existing.sha256 !== digest || existing.width !== input.width || existing.height !== input.height || existing.revision !== input.revision || existing.pageNumber !== input.pageNumber) throw new Error("PREVIEW_IDEMPOTENCY_CONFLICT");
      return { assetId: existing.assetId, mimeType: "image/png" as const, sha256: existing.sha256, width: existing.width, height: existing.height, revision: existing.revision, ...(existing.pageNumber === undefined ? {} : { pageNumber: existing.pageNumber }) };
    }
    const assetId = crypto.randomUUID();
    const objectKey = buildTaskObjectKey({ userId: input.ownerUserId, taskId: input.taskId, category: "assets", fileName: `${assetId}.png` });
    await this.storage.put(objectKey, input.bytes, "image/png");
    try {
      await this.assets.createPreview({ id: assetId, ownerUserId: input.ownerUserId, taskId: input.taskId, objectKey, sha256: digest, width: input.width, height: input.height, revision: input.revision, pageNumber: input.pageNumber, providerRequestId });
    } catch (error) {
      await this.storage.remove(objectKey).catch(() => undefined);
      const raced = await this.assets.findPreviewByRequest({ ownerUserId: input.ownerUserId, taskId: input.taskId, providerRequestId });
      if (raced && raced.sha256 === digest && raced.width === input.width && raced.height === input.height && raced.revision === input.revision && raced.pageNumber === input.pageNumber) return { assetId: raced.assetId, mimeType: "image/png" as const, sha256: raced.sha256, width: raced.width, height: raced.height, revision: raced.revision, ...(raced.pageNumber === undefined ? {} : { pageNumber: raced.pageNumber }) };
      throw error;
    }
    return { assetId, mimeType: "image/png" as const, sha256: digest, width: input.width, height: input.height, revision: input.revision, ...(input.pageNumber ? { pageNumber: input.pageNumber } : {}) };
  }
}
