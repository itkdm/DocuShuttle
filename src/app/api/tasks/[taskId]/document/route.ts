import { NextResponse } from "next/server";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params;
    const { client, userId } = await requireSupabaseIdentity();
    const document = await client
      .from("working_documents")
      .select("id, current_version_id")
      .eq("task_id", taskId)
      .eq("owner_user_id", userId)
      .single();
    if (document.error || !document.data) return NextResponse.json({ code: "DOCUMENT_NOT_FOUND" }, { status: 404 });
    const version = await client
      .from("document_versions")
      .select("id, version_number, object_key, sha256")
      .eq("id", document.data.current_version_id)
      .eq("owner_user_id", userId)
      .single();
    if (version.error || !version.data) return NextResponse.json({ code: "VERSION_NOT_FOUND" }, { status: 404 });
    const downloadUrl = await new SupabaseStorageAdapter(client).createSignedDownload(version.data.object_key as string, 5 * 60);
    return NextResponse.json({
      documentId: document.data.id,
      version: {
        id: version.data.id,
        number: version.data.version_number,
        revision: version.data.sha256,
      },
      downloadUrl,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") {
      return NextResponse.json({ code: error.message }, { status: 401 });
    }
    logger.error("http.request.failed", { route: "/api/tasks/:taskId/document", error });
    return NextResponse.json({ code: "CURRENT_DOCUMENT_FAILED" }, { status: 500 });
  }
}
