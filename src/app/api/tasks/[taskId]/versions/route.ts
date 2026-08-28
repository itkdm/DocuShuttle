import { NextResponse } from "next/server";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params;
    const { client, userId } = await requireSupabaseIdentity();
    const document = await client.from("working_documents").select("id, current_version_id").eq("task_id", taskId).eq("owner_user_id", userId).single();
    if (document.error || !document.data) return NextResponse.json({ code: "DOCUMENT_NOT_FOUND" }, { status: 404 });
    const versions = await client.from("document_versions")
      .select("id, version_number, origin, sha256, created_at")
      .eq("working_document_id", document.data.id)
      .eq("owner_user_id", userId).order("version_number", { ascending: false });
    if (versions.error) throw versions.error;
    return NextResponse.json({ currentVersionId: document.data.current_version_id, versions: versions.data });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    return NextResponse.json({ code: "VERSIONS_LOAD_FAILED" }, { status: 500 });
  }
}
