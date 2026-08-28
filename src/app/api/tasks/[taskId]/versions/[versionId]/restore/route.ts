import { NextResponse } from "next/server";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";

export async function POST(_request: Request, { params }: { params: Promise<{ taskId: string; versionId: string }> }) {
  try {
    const { taskId, versionId } = await params;
    const { client } = await requireSupabaseIdentity();
    const result = await client.rpc("restore_document_version", { p_task_id: taskId, p_source_version_id: versionId }).single();
    if (result.error || !result.data) return NextResponse.json({ code: "VERSION_RESTORE_FAILED" }, { status: 409 });
    return NextResponse.json({ version: result.data });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    return NextResponse.json({ code: "VERSION_RESTORE_FAILED" }, { status: 500 });
  }
}
