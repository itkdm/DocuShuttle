import { NextResponse } from "next/server";
import { z } from "zod";

import { logger } from "@/infrastructure/observability";
import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { CommitManualDocumentEdit, MANUAL_EDIT_DOCX_MIME, ManualEditError } from "@/modules/documents";
import { OoxmlPreservationKernel } from "@/modules/documents/infrastructure/ooxml/ooxml-preservation-kernel";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { SupabaseUserDocumentVersionCommit, SupabaseWorkingDocumentSnapshot } from "@/modules/generation/infrastructure/supabase-image-application";

const paramsSchema = z.object({ taskId: z.uuid() });

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = paramsSchema.parse(await params);
    const { client, userId } = await requireSupabaseIdentity();
    const form = await request.formData();
    const file = form.get("file");
    const expectedRevision = form.get("expectedRevision");
    if (!(file instanceof File) || typeof expectedRevision !== "string") return NextResponse.json({ code: "MANUAL_EDIT_REQUEST_INVALID" }, { status: 400 });
    const result = await new CommitManualDocumentEdit(
      new SupabaseWorkingDocumentSnapshot(client),
      new SupabaseUserDocumentVersionCommit(client),
      new SupabaseStorageAdapter(client),
      new OoxmlPreservationKernel(),
    ).execute({ taskId, ownerUserId: userId, expectedRevision, bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type as typeof MANUAL_EDIT_DOCX_MIME, fileName: file.name });
    return NextResponse.json(result, { status: result.noChange ? 200 : 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
    if (error instanceof ManualEditError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.code === "DOCUMENT_REVISION_MISMATCH" ? 409 : 422 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    logger.error("http.request.failed", { route: "/api/tasks/:taskId/document/manual-edit", error });
    return NextResponse.json({ code: "MANUAL_EDIT_FAILED" }, { status: 500 });
  }
}
