import { buildTaskObjectKey } from "@/modules/storage/object-key";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import type { SourceRole } from "@/modules/tasks/domain";
import type { TaskRepositoryPort } from "@/modules/tasks/ports";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MAX_DOCX_BYTES = 20 * 1024 * 1024;

export class CreateSourceUpload {
  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly storage: PrivateObjectStoragePort,
  ) {}

  async execute(input: {
    ownerUserId: string;
    taskId: string;
    role: SourceRole;
    originalName: string;
    byteLength: number;
  }) {
    if (!(await this.tasks.belongsToOwner(input.taskId, input.ownerUserId))) {
      throw new Error("TASK_NOT_FOUND");
    }
    if (!input.originalName.toLocaleLowerCase().endsWith(".docx")) {
      throw new Error("DOCX_REQUIRED");
    }
    if (input.byteLength < 1 || input.byteLength > MAX_DOCX_BYTES) {
      throw new Error("FILE_SIZE_OUT_OF_RANGE");
    }

    const objectKey = buildTaskObjectKey({
      userId: input.ownerUserId,
      taskId: input.taskId,
      category: "sources",
      fileName: `${crypto.randomUUID()}.docx`,
    });
    const upload = await this.storage.createSignedUpload({
      objectKey,
      mimeType: DOCX_MIME,
      maxBytes: MAX_DOCX_BYTES,
      expiresInSeconds: 10 * 60,
    });
    return { upload, role: input.role, originalName: input.originalName };
  }
}
