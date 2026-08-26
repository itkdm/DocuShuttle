import type { DocumentEnginePort } from "@/modules/documents";
import { sha256 } from "@/modules/documents/infrastructure/ooxml/hash";
import { assertTaskObjectKey, buildTaskObjectKey } from "@/modules/storage/object-key";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import type { SourceRole } from "@/modules/tasks/domain";
import type { TaskRepositoryPort } from "@/modules/tasks/ports";

import { DOCX_MIME, MAX_DOCX_BYTES } from "./create-source-upload";

export class CompleteSourceUpload {
  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly storage: PrivateObjectStoragePort,
    private readonly documents: DocumentEnginePort,
  ) {}

  async execute(input: {
    ownerUserId: string;
    taskId: string;
    role: SourceRole;
    originalName: string;
    objectKey: string;
    expectedBytes: number;
    expectedSha256: string;
  }) {
    if (!(await this.tasks.belongsToOwner(input.taskId, input.ownerUserId))) {
      throw new Error("TASK_NOT_FOUND");
    }
    const objectKey = assertTaskObjectKey(input.objectKey);
    const expectedPrefix = `users/${input.ownerUserId}/tasks/${input.taskId}/sources/`;
    if (!objectKey.startsWith(expectedPrefix)) throw new Error("OBJECT_SCOPE_MISMATCH");

    const bytes = await this.storage.get(objectKey);
    if (bytes.byteLength !== input.expectedBytes || bytes.byteLength > MAX_DOCX_BYTES) {
      await this.storage.remove(objectKey);
      throw new Error("UPLOAD_SIZE_MISMATCH");
    }
    const actualSha256 = await sha256(bytes);
    if (actualSha256 !== input.expectedSha256.toLowerCase()) {
      await this.storage.remove(objectKey);
      throw new Error("UPLOAD_CHECKSUM_MISMATCH");
    }

    let manifestObjectKey: string | undefined;
    try {
      const inspection = await this.documents.inspect(bytes);
      if (inspection.diagnostics.some(({ severity }) => severity === "error")) {
        throw new Error("DOCX_INSPECTION_FAILED");
      }
      manifestObjectKey = buildTaskObjectKey({
        userId: input.ownerUserId,
        taskId: input.taskId,
        category: "manifests",
        fileName: `${crypto.randomUUID()}.json`,
      });
      await this.storage.put(
        manifestObjectKey,
        new TextEncoder().encode(JSON.stringify(inspection)),
        "application/json",
      );
      const registered = await this.tasks.registerSource({
        ownerUserId: input.ownerUserId,
        taskId: input.taskId,
        role: input.role,
        originalName: input.originalName,
        objectKey,
        mimeType: DOCX_MIME,
        byteLength: bytes.byteLength,
        sha256: actualSha256,
        inspection,
        manifestObjectKey,
        engineVersion: "paperduck-ooxml-v1",
      });
      // Keep role metadata in the response so clients can distinguish the
      // editable template from reference examples regardless of upload order.
      return {
        ...registered,
        role: input.role,
        originalName: input.originalName,
        inspection,
      };
    } catch (error) {
      await this.storage.remove(objectKey);
      if (manifestObjectKey) await this.storage.remove(manifestObjectKey);
      throw error;
    }
  }
}
