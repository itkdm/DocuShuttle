export type TaskStatus = "draft" | "ready" | "running" | "review" | "completed" | "failed" | "archived";

export type TaskRecord = {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  status: TaskStatus;
};

export type SourceRole = "template" | "example" | "auxiliary";

export type TaskSourceRecord = {
  id: string;
  role: SourceRole;
  originalName: string;
  byteLength: number;
};

export type TaskSummary = {
  id: string;
  title: string;
  status: TaskStatus;
  updatedAt: string;
  fileName: string;
};

export type TaskWorkspace = {
  task: TaskRecord;
  sources: readonly TaskSourceRecord[];
  workingDocumentId?: string;
  latestRunId?: string;
  fileName: string;
};
