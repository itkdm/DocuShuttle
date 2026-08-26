import type { SupabaseClient } from "@supabase/supabase-js";

import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import type { SourceDocumentContextPort, SourceDocumentDescriptor, SourceDocumentPayload } from "../../application/source-context-tools";
import type { SourceRole } from "@/modules/tasks/domain";

type SourceRow = {
  id: string;
  role: SourceRole;
  original_name: string;
  mime_type: string;
  byte_length: number;
  sha256: string;
  created_at: string;
  inspection: unknown;
  object_key?: string;
};

const mapDescriptor = (row: SourceRow): SourceDocumentDescriptor => ({
  sourceFileId: row.id,
  role: row.role,
  originalName: row.original_name,
  mimeType: row.mime_type,
  byteLength: Number(row.byte_length),
  sha256: row.sha256,
  createdAt: row.created_at,
  inspection: row.inspection,
});

/** Supabase adapter; RLS remains the authority for owner isolation. */
export class SupabaseSourceDocumentContext implements SourceDocumentContextPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly storage = new SupabaseStorageAdapter(client),
  ) {}

  async list(taskId: string): Promise<readonly SourceDocumentDescriptor[]> {
    const result = await this.client
      .from("source_files")
      .select("id, role, original_name, mime_type, byte_length, sha256, created_at, inspection")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true });
    if (result.error) throw new Error(`Unable to list source documents: ${result.error.message}`);
    return (result.data as SourceRow[]).map(mapDescriptor);
  }

  async load(taskId: string, sourceFileId: string): Promise<SourceDocumentPayload | null> {
    const result = await this.client
      .from("source_files")
      .select("id, role, original_name, mime_type, byte_length, sha256, created_at, inspection, object_key")
      .eq("task_id", taskId)
      .eq("id", sourceFileId)
      .maybeSingle();
    if (result.error) throw new Error(`Unable to load source document: ${result.error.message}`);
    if (!result.data) return null;
    const row = result.data as SourceRow;
    if (!row.object_key) throw new Error("SOURCE_DOCUMENT_OBJECT_KEY_MISSING");
    return { descriptor: mapDescriptor(row), bytes: await this.storage.get(row.object_key) };
  }
}
