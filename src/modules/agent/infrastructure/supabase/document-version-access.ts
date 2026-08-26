import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  DocumentVersionAccessPort,
  DocumentVersionSummary,
} from "../../application/document-version-tools";
import { SupabaseStorageAdapter } from "../../../storage/adapters/supabase-storage";

type VersionRow = {
  id: string;
  version_number: number;
  origin: DocumentVersionSummary["origin"];
  sha256: string;
  created_at: string;
};

type ExportRow = {
  export_id: string;
  version_id: string;
  version_number: number;
  revision: string;
  object_key: string;
};

type RestoreRow = { version_id: string; version_number: number; revision: string };

/** Binds immutable document version actions to a single task under Supabase RLS. */
export class SupabaseDocumentVersionAccess implements DocumentVersionAccessPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly taskId: string,
    private readonly storage = new SupabaseStorageAdapter(client),
  ) {}

  async list() {
    const document = await this.client
      .from("working_documents")
      .select("id, current_version_id")
      .eq("task_id", this.taskId)
      .single();
    if (document.error || !document.data) throw new Error("DOCUMENT_NOT_FOUND");

    const versions = await this.client
      .from("document_versions")
      .select("id, version_number, origin, sha256, created_at")
      .eq("working_document_id", document.data.id)
      .order("version_number", { ascending: false });
    if (versions.error) throw new Error(`Unable to list document versions: ${versions.error.message}`);

    return {
      currentVersionId: document.data.current_version_id as string,
      versions: (versions.data as VersionRow[]).map((version) => ({
        id: version.id,
        number: Number(version.version_number),
        origin: version.origin,
        revision: version.sha256,
        createdAt: version.created_at,
      })),
    };
  }

  async exportCurrent() {
    const result = await this.client.rpc("record_document_export", { p_task_id: this.taskId }).single();
    if (result.error || !result.data) throw new Error(`DOCUMENT_EXPORT_FAILED${result.error ? `: ${result.error.message}` : ""}`);
    const row = result.data as ExportRow;
    return {
      exportId: row.export_id,
      versionId: row.version_id,
      versionNumber: Number(row.version_number),
      revision: row.revision,
      downloadUrl: await this.storage.createSignedDownload(row.object_key, 5 * 60),
    };
  }

  async restore(input: { versionId: string; expectedRevision?: string }) {
    if (input.expectedRevision) {
      const current = await this.client
        .from("working_documents")
        .select("current_version_id")
        .eq("task_id", this.taskId)
        .single();
      if (current.error || !current.data) throw new Error("DOCUMENT_NOT_FOUND");
      const version = await this.client
        .from("document_versions")
        .select("sha256")
        .eq("id", current.data.current_version_id)
        .single();
      if (version.error || !version.data) throw new Error("VERSION_NOT_FOUND");
      if (version.data.sha256 !== input.expectedRevision) {
        throw new Error(`DOCUMENT_REVISION_CONFLICT:${version.data.sha256}`);
      }
    }

    const result = await this.client.rpc("restore_document_version", {
      p_task_id: this.taskId,
      p_source_version_id: input.versionId,
    }).single();
    if (result.error || !result.data) throw new Error(`VERSION_RESTORE_FAILED${result.error ? `: ${result.error.message}` : ""}`);
    const row = result.data as RestoreRow;
    return {
      versionId: row.version_id,
      versionNumber: Number(row.version_number),
      revision: row.revision,
    };
  }
}
