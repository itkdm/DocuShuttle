import type { SourceRole, TaskRecord } from "./domain";

export interface TaskRepositoryPort {
  create(input: {
    ownerUserId: string;
    title: string;
    goal: string;
  }): Promise<TaskRecord>;
  belongsToOwner(taskId: string, ownerUserId: string): Promise<boolean>;
  registerSource(input: {
    ownerUserId: string;
    taskId: string;
    role: SourceRole;
    originalName: string;
    objectKey: string;
    mimeType: string;
    byteLength: number;
    sha256: string;
    inspection: unknown;
    manifestObjectKey: string;
    engineVersion: string;
  }): Promise<{ sourceFileId: string; workingDocumentId?: string; versionId?: string }>;
}
