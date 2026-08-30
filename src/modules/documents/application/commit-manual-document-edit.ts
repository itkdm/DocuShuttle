import { z } from "zod";
import type { DocumentEnginePort } from "./document-engine-port";
import { inspectManualEditCapabilities, type ManualDocumentEditCapability } from "./manual-edit-capability";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import { buildTaskObjectKey } from "@/modules/storage/object-key";
import type { DocumentRoundTripSentinelPort } from "./document-round-trip-sentinel-port";

export const MANUAL_EDIT_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
const MAX_BYTES = 20 * 1024 * 1024;
const signature = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

export const manualEditInputSchema = z.object({ taskId: z.string().uuid(), expectedRevision: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.instanceof(Uint8Array), mimeType: z.literal(MANUAL_EDIT_DOCX_MIME), fileName: z.string().min(1).max(255) });
export type ManualEditInput = z.infer<typeof manualEditInputSchema> & { ownerUserId: string };

export interface ManualEditDocumentPort { load(input: { taskId: string; ownerUserId: string }): Promise<{ documentId: string; objectKey: string; revision: string } | null>; }
export interface ManualEditVersionPort { commit(input: { documentId: string; expectedRevision: string; derivedRevision: string; objectKey: string; manifestObjectKey: string; validation: unknown; operationLog: unknown }): Promise<{ versionId: string; versionNumber: number } | { kind: "revision-conflict"; actualRevision: string }>; }

export class ManualEditError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = "ManualEditError"; } }

export class CommitManualDocumentEdit {
  constructor(private readonly documents: ManualEditDocumentPort, private readonly versions: ManualEditVersionPort, private readonly storage: PrivateObjectStoragePort, private readonly engine: DocumentEnginePort, private readonly sentinel: DocumentRoundTripSentinelPort) {}

  async execute(raw: ManualEditInput) {
    const input = manualEditInputSchema.parse(raw);
    if (input.bytes.byteLength > MAX_BYTES || !signature(input.bytes)) throw new ManualEditError("MANUAL_EDIT_DOCX_INVALID", "Invalid DOCX package.");
    const current = await this.documents.load({ taskId: input.taskId, ownerUserId: raw.ownerUserId });
    if (!current) throw new ManualEditError("DOCUMENT_NOT_FOUND", "Working document was not found.");
    if (current.revision !== input.expectedRevision) throw new ManualEditError("DOCUMENT_REVISION_MISMATCH", "The document changed while it was being edited.");
    const sourceBytes = await this.storage.get(current.objectKey);
    const sourceUnsupported = await inspectManualEditCapabilities(sourceBytes);
    if (sourceUnsupported.length) throw new ManualEditError("MANUAL_EDIT_UNSUPPORTED_FEATURE", `Manual editing does not support: ${sourceUnsupported.join(", ")}.`);
    const outputUnsupported = await inspectManualEditCapabilities(input.bytes);
    if (outputUnsupported.length) throw new ManualEditError("MANUAL_EDIT_UNSUPPORTED_FEATURE", `Manual editing does not support: ${outputUnsupported.join(", ")}.`);
    const preservation = await this.sentinel.verify({ sourceBytes, outputBytes: input.bytes });
    if (!preservation.safe) {
      throw new ManualEditError("MANUAL_EDIT_ROUND_TRIP_UNSAFE", "这次修改无法安全保存，因为编辑器可能会丢失文档中的部分原有内容。原文档没有被修改，本次编辑尚未保存。");
    }
    const validation = await this.engine.validate(input.bytes);
    const reopened = await this.engine.inspect(input.bytes);
    if (reopened.manifest.revision !== validation.manifest.revision) throw new ManualEditError("MANUAL_EDIT_VALIDATION_MISMATCH", "The edited document failed reopen validation.");
    const revision = validation.manifest.revision;
    if (revision === current.revision) return { noChange: true, revision };
    const versionId = crypto.randomUUID();
    const objectKey = buildTaskObjectKey({ userId: raw.ownerUserId, taskId: input.taskId, category: "versions", fileName: `${versionId}.docx` });
    const manifestObjectKey = buildTaskObjectKey({ userId: raw.ownerUserId, taskId: input.taskId, category: "manifests", fileName: `${versionId}.json` });
    let createdDocx = false; let createdManifest = false; let rpcAttempted = false;
    try {
      await this.storage.put(objectKey, input.bytes, MANUAL_EDIT_DOCX_MIME); createdDocx = true;
      await this.storage.put(manifestObjectKey, new TextEncoder().encode(JSON.stringify(validation.manifest)), "application/json"); createdManifest = true;
      rpcAttempted = true;
      const committed = await this.versions.commit({ documentId: current.documentId, expectedRevision: input.expectedRevision, derivedRevision: revision, objectKey, manifestObjectKey, validation: reopened, operationLog: [{ kind: "manual-edit", fileName: input.fileName }] });
      if ("kind" in committed) {
        await this.storage.remove(objectKey).catch(() => undefined);
        await this.storage.remove(manifestObjectKey).catch(() => undefined);
        throw new ManualEditError("DOCUMENT_REVISION_MISMATCH", "The document changed while it was being edited.");
      }
      return { ...committed, revision, noChange: false };
    } catch (error) {
      // Once the commit RPC has been attempted, an unknown error may mean the
      // database committed but its response was lost. Never delete objects in
      // that state; the committed version owns them.
      if (!rpcAttempted) {
        if (createdDocx) await this.storage.remove(objectKey).catch(() => undefined);
        if (createdManifest) await this.storage.remove(manifestObjectKey).catch(() => undefined);
      }
      throw error;
    }
  }
}

export type { ManualDocumentEditCapability };
