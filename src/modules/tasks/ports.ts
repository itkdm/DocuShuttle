import type { SourceRole, TaskRecord, TaskSourceRecord, TaskSummary } from "./domain";

export interface TaskRepositoryPort {
  create(input: {
    ownerUserId: string;
    title: string;
    goal: string;
  }): Promise<TaskRecord>;
  listByOwner(ownerUserId: string): Promise<TaskSummary[]>;
  getWorkspace(taskId: string, ownerUserId: string): Promise<{
    task: TaskRecord;
    sources: TaskSourceRecord[];
    workingDocumentId?: string;
    latestRunId?: string;
  } | undefined>;
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
