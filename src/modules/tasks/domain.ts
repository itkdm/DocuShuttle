export type TaskRecord = {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  status: "draft" | "ready";
};

export type SourceRole = "template" | "example" | "auxiliary";
