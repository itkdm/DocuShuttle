import { NextResponse } from "next/server";
import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { OoxmlPreservationKernel } from "@/modules/documents/infrastructure/ooxml/ooxml-preservation-kernel";

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params;
    const { client, user } = await requireSupabaseUser();
    const document = await client.from("working_documents").select("id, current_version_id").eq("task_id", taskId).eq("owner_user_id", user.id).maybeSingle();
    if (document.error || !document.data?.current_version_id) return NextResponse.json({ code: "DOCUMENT_NOT_FOUND" }, { status: 404 });
    const version = await client.from("document_versions").select("object_key, sha256").eq("id", document.data.current_version_id).eq("owner_user_id", user.id).single();
    if (version.error || !version.data) return NextResponse.json({ code: "VERSION_NOT_FOUND" }, { status: 404 });
    const inspection = await new OoxmlPreservationKernel().inspect(await new SupabaseStorageAdapter(client).get(version.data.object_key as string));
    return NextResponse.json({ revision: version.data.sha256, images: inspection.images.map(({ address, contentType, byteLength }) => ({ nodeId: address.nodeId, contentType, byteLength, path: address.path })) });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    console.error("document_inspection_failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ code: "DOCUMENT_INSPECTION_FAILED" }, { status: 500 });
  }
}
