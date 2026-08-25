import type { SupabaseClient } from "@supabase/supabase-js";

import type { TaskRecord } from "../domain";
import type { TaskRepositoryPort } from "../ports";

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
      status: created.data.status as TaskRecord["status"],
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
