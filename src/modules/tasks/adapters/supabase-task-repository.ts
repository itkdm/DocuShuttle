import type { SupabaseClient } from "@supabase/supabase-js";

import type { SourceRole, TaskRecord, TaskSourceRecord, TaskStatus, TaskSummary } from "../domain";
import { fileNameForTask } from "../task-url";
import type { TaskRepositoryPort } from "../ports";

const asStatus = (value: string): TaskStatus => {
  switch (value) {
    case "draft":
    case "ready":
    case "running":
    case "review":
    case "completed":
    case "failed":
    case "archived":
      return value;
    default:
      return "draft";
  }
};

const asRole = (value: string): SourceRole => {
  if (value === "example" || value === "auxiliary") return value;
  return "template";
};

const fail = (context: string, error: { message: string } | null) => {
  if (error) throw new Error(`${context}: ${error.message}`);
};

export class SupabaseTaskRepository implements TaskRepositoryPort {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: {
    ownerUserId: string;
    title: string;
    goal: string;
  }): Promise<TaskRecord> {
    const existing = await this.client
      .from("workspaces")
      .select("id")
      .eq("owner_user_id", input.ownerUserId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    fail("Unable to read workspace", existing.error);

    let workspaceId = existing.data?.id as string | undefined;
    if (!workspaceId) {
      const created = await this.client
        .from("workspaces")
        .insert({ owner_user_id: input.ownerUserId, title: "我的工作区" })
        .select("id")
        .single();
      fail("Unable to create workspace", created.error);
      if (!created.data) throw new Error("Unable to create workspace: no row returned");
      workspaceId = created.data.id as string;
    }

    const created = await this.client
      .from("tasks")
      .insert({
        owner_user_id: input.ownerUserId,
        workspace_id: workspaceId,
        title: input.title,
        goal: input.goal,
        status: "draft",
      })
      .select("id, workspace_id, title, goal, status")
      .single();
    fail("Unable to create task", created.error);
    if (!created.data) throw new Error("Unable to create task: no row returned");

    return {
      id: created.data.id as string,
      workspaceId: created.data.workspace_id as string,
      title: created.data.title as string,
      goal: created.data.goal as string,
      status: asStatus(created.data.status as string),
    };
  }

  async listByOwner(ownerUserId: string): Promise<TaskSummary[]> {
    const result = await this.client
      .from("tasks")
      .select("id, title, status, updated_at, source_files(role, original_name)")
      .eq("owner_user_id", ownerUserId)
      .neq("status", "archived")
      .order("updated_at", { ascending: false })
      .limit(50);
    fail("Unable to list tasks", result.error);
    return (result.data ?? []).map((row) => {
      const sources = ((row.source_files as Array<{ role: string; original_name: string }> | null) ?? [])
        .map((source) => ({ role: source.role, originalName: source.original_name }));
      return {
        id: row.id as string,
        title: row.title as string,
        status: asStatus(row.status as string),
        updatedAt: row.updated_at as string,
        fileName: fileNameForTask({ title: row.title as string, sources }),
      };
    });
  }

  async getWorkspace(taskId: string, ownerUserId: string) {
    // These projections are independent. Run them concurrently so a slow
    // Supabase round-trip does not multiply the time needed to open a task.
    const [task, sources, working, latestRun] = await Promise.all([
      this.client
        .from("tasks")
        .select("id, workspace_id, title, goal, status")
        .eq("id", taskId)
        .eq("owner_user_id", ownerUserId)
        .maybeSingle(),
      this.client
        .from("source_files")
        .select("id, role, original_name, byte_length")
        .eq("task_id", taskId)
        .eq("owner_user_id", ownerUserId)
        .order("created_at", { ascending: true }),
      this.client
        .from("working_documents")
        .select("id")
        .eq("task_id", taskId)
        .eq("owner_user_id", ownerUserId)
        .maybeSingle(),
      this.client
        .from("agent_runs")
        .select("id")
        .eq("task_id", taskId)
        .eq("owner_user_id", ownerUserId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    fail("Unable to read task", task.error);
    fail("Unable to read source files", sources.error);
    fail("Unable to read working document", working.error);
    fail("Unable to read agent run", latestRun.error);
    if (!task.data) return undefined;

    const sourceRecords: TaskSourceRecord[] = (sources.data ?? []).map((row) => ({
      id: row.id as string,
      role: asRole(row.role as string),
      originalName: row.original_name as string,
      byteLength: Number(row.byte_length),
    }));

    return {
      task: {
        id: task.data.id as string,
        workspaceId: task.data.workspace_id as string,
        title: task.data.title as string,
        goal: task.data.goal as string,
        status: asStatus(task.data.status as string),
      },
      sources: sourceRecords,
      workingDocumentId: (working.data?.id as string | undefined) ?? undefined,
      latestRunId: (latestRun.data?.id as string | undefined) ?? undefined,
    };
  }

  async belongsToOwner(taskId: string, ownerUserId: string): Promise<boolean> {
    const result = await this.client
      .from("tasks")
      .select("id")
      .eq("id", taskId)
      .eq("owner_user_id", ownerUserId)
      .maybeSingle();
    fail("Unable to verify task", result.error);
    return Boolean(result.data);
  }

  async registerSource(input: Parameters<TaskRepositoryPort["registerSource"]>[0]) {
    const result = await this.client.rpc("register_source_and_import", {
      p_task_id: input.taskId,
      p_role: input.role,
      p_original_name: input.originalName,
      p_object_key: input.objectKey,
      p_mime_type: input.mimeType,
      p_byte_length: input.byteLength,
      p_sha256: input.sha256,
      p_inspection: input.inspection,
      p_manifest_object_key: input.manifestObjectKey,
      p_engine_version: input.engineVersion,
    }).single();
    fail("Unable to register source", result.error);
    if (!result.data) throw new Error("Unable to register source: no row returned");
    const row = result.data as {
      source_file_id: string;
      working_document_id?: string | null;
      version_id?: string | null;
    };
    return {
      sourceFileId: row.source_file_id,
      workingDocumentId: row.working_document_id ?? undefined,
      versionId: row.version_id ?? undefined,
    };
  }
}
