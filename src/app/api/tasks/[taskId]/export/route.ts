import { NextResponse } from "next/server";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";

export async function POST(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params;
    const { client } = await requireSupabaseUser();
    const result = await client.rpc("record_document_export", { p_task_id: taskId }).single();
    if (result.error || !result.data) return NextResponse.json({ code: "EXPORT_FAILED" }, { status: 409 });
    const row = result.data as { export_id: string; version_id: string; version_number: number; revision: string; object_key: string };
    const downloadUrl = await new SupabaseStorageAdapter(client).createSignedDownload(row.object_key, 5 * 60);
    return NextResponse.json({ export: { id: row.export_id, versionId: row.version_id, number: row.version_number, revision: row.revision }, downloadUrl });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    return NextResponse.json({ code: "EXPORT_FAILED" }, { status: 500 });
  }
}
