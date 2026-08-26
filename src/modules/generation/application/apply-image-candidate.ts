import type { DocumentEnginePort } from "@/modules/documents/application/document-engine-port";
import type { ImageAddress } from "@/modules/documents/domain/types";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import { buildTaskObjectKey } from "@/modules/storage/object-key";
import { z } from "zod";

export const applyImageCandidateInputSchema = z.object({
  taskId: z.string().uuid(),
  assetId: z.string().uuid(),
  targetNodeId: z.string().min(1).max(256),
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ApplyImageCandidateInput = z.infer<typeof applyImageCandidateInputSchema> & { ownerUserId: string };

export interface ImageCandidateSourcePort { load(input: { assetId: string; taskId: string; ownerUserId: string }): Promise<{ objectKey: string; mimeType: string } | null>; }
export interface WorkingDocumentSnapshotPort { load(input: { taskId: string; ownerUserId: string }): Promise<{ documentId: string; objectKey: string; revision: string; versionNumber: number } | null>; }
export interface UserDocumentVersionCommitPort { commit(input: { documentId: string; expectedRevision: string; derivedRevision: string; objectKey: string; manifestObjectKey: string; validation: unknown; operationLog: unknown }): Promise<{ versionId: string; versionNumber: number } | { kind: "revision-conflict"; actualRevision: string }>; }

export class ApplyImageCandidateError extends Error { readonly code = "IMAGE_CANDIDATE_APPLY_INVALID"; }

export class ApplyImageCandidate {
  constructor(private readonly assets: ImageCandidateSourcePort, private readonly documents: WorkingDocumentSnapshotPort, private readonly versions: UserDocumentVersionCommitPort, private readonly storage: PrivateObjectStoragePort, private readonly engine: DocumentEnginePort) {}

  async execute(raw: ApplyImageCandidateInput) {
    const input = applyImageCandidateInputSchema.parse(raw);
    const asset = await this.assets.load({ ...input, ownerUserId: raw.ownerUserId });
    if (!asset) throw new ApplyImageCandidateError("Image candidate was not found.");
    const current = await this.documents.load({ ...input, ownerUserId: raw.ownerUserId });
    if (!current) throw new ApplyImageCandidateError("Working document was not found.");
    if (current.revision !== input.expectedRevision) throw new ApplyImageCandidateError("The document changed; reload before applying the candidate.");
    const source = await this.storage.get(current.objectKey);
    const inspection = await this.engine.inspect(source);
    const image = inspection.images.find((item) => item.address.nodeId === input.targetNodeId);
    if (!image) throw new ApplyImageCandidateError("The target image node was not found in the current document.");
    const bytes = await this.storage.get(asset.objectKey);
    const result = await this.engine.mutate(source, { expectedRevision: input.expectedRevision, operations: [{ kind: "replace-image", address: image.address as ImageAddress, expectedHash: image.address.fingerprint, bytes, contentType: image.contentType ?? asset.mimeType }] });
    const validation = await this.engine.validate(result.bytes);
    const versionId = crypto.randomUUID();
    const base = { userId: raw.ownerUserId, taskId: input.taskId };
    const objectKey = buildTaskObjectKey({ ...base, category: "versions", fileName: `${versionId}.docx` });
    const manifestObjectKey = buildTaskObjectKey({ ...base, category: "manifests", fileName: `${versionId}.json` });
    await this.storage.put(objectKey, result.bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await this.storage.put(manifestObjectKey, new TextEncoder().encode(JSON.stringify(result.manifest)), "application/json");
    try {
      const committed = await this.versions.commit({ documentId: current.documentId, expectedRevision: input.expectedRevision, derivedRevision: result.manifest.revision, objectKey, manifestObjectKey, validation, operationLog: [{ kind: "replace-image", targetNodeId: input.targetNodeId, assetId: input.assetId }] });
      if ("kind" in committed) throw new ApplyImageCandidateError("The document changed; reload before applying the candidate.");
      return { ...committed, revision: result.manifest.revision };
    } catch (error) {
      await this.storage.remove(objectKey).catch(() => undefined);
      await this.storage.remove(manifestObjectKey).catch(() => undefined);
      throw error;
    }
  }
}
