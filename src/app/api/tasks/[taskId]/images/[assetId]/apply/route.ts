import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "@/infrastructure/observability";
import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { OoxmlPreservationKernel } from "@/modules/documents/infrastructure/ooxml/ooxml-preservation-kernel";
import { ApplyImageCandidate, applyImageCandidateInputSchema, ApplyImageCandidateError } from "@/modules/generation/application/apply-image-candidate";
import { SupabaseImageCandidateSource, SupabaseUserDocumentVersionCommit, SupabaseWorkingDocumentSnapshot } from "@/modules/generation/infrastructure/supabase-image-application";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string; assetId: string }> }) {
  try {
    const { taskId, assetId } = await params;
    const { client, user } = await requireSupabaseUser();
    const body = applyImageCandidateInputSchema.parse({ ...(await request.json()), taskId, assetId });
    const result = await new ApplyImageCandidate(new SupabaseImageCandidateSource(client), new SupabaseWorkingDocumentSnapshot(client), new SupabaseUserDocumentVersionCommit(client), new SupabaseStorageAdapter(client), new OoxmlPreservationKernel()).execute({ ...body, ownerUserId: user.id });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError || error instanceof ApplyImageCandidateError) return NextResponse.json({ code: "INVALID_IMAGE_APPLY", message: error instanceof Error ? error.message : "Invalid image apply request." }, { status: 409 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    logger.error("http.request.failed", { route: "/api/tasks/:taskId/images/:assetId/apply", error });
    return NextResponse.json({ code: "IMAGE_APPLY_FAILED" }, { status: 500 });
  }
}
