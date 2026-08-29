import { logger } from "@/infrastructure/observability";
import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { OoxmlPreservationKernel } from "@/modules/documents/infrastructure/ooxml/ooxml-preservation-kernel";
import { SupabaseWorkingDocumentSnapshot } from "@/modules/generation/infrastructure/supabase-image-application";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";

const allowedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function GET(request: Request, { params }: { params: Promise<{ taskId: string; nodeId: string }> }) {
  try {
    const { taskId, nodeId } = await params;
    const { client, userId } = await requireSupabaseIdentity();
    const snapshot = await new SupabaseWorkingDocumentSnapshot(client).load({ taskId, ownerUserId: userId });
    if (!snapshot) return new Response(null, { status: 404 });
    const requestedRevision = new URL(request.url).searchParams.get("revision");
    if (requestedRevision && requestedRevision !== snapshot.revision) return Response.json({ code: "DOCUMENT_REVISION_CONFLICT" }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    const image = await new OoxmlPreservationKernel().readImage?.(await new SupabaseStorageAdapter(client).get(snapshot.objectKey), nodeId);
    if (!image || !allowedMimeTypes.has(image.contentType)) return new Response(null, { status: 404 });
    return new Response(image.bytes as BodyInit, { status: 200, headers: { "Content-Type": image.contentType, "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return Response.json({ code: error.message }, { status: 401 });
    logger.error("http.request.failed", { route: "/api/tasks/:taskId/document/images/:nodeId", error });
    return Response.json({ code: "DOCUMENT_IMAGE_PREVIEW_FAILED" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
}

