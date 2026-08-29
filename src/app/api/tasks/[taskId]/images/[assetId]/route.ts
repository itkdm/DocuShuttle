import { logger } from "@/infrastructure/observability";
import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { SupabaseGeneratedAssetStore } from "@/modules/generation/infrastructure/supabase-generated-asset-store";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";

const allowedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string; assetId: string }> }) {
  try {
    const { taskId, assetId } = await params;
    const { client, userId } = await requireSupabaseIdentity();
    const asset = await new SupabaseGeneratedAssetStore(client).load({ assetId, taskId, ownerUserId: userId });
    if (!asset || !allowedMimeTypes.has(asset.mimeType)) return new Response(null, { status: 404 });
    const bytes = await new SupabaseStorageAdapter(client).get(asset.objectKey);
    return new Response(bytes as BodyInit, { status: 200, headers: { "Content-Type": asset.mimeType, "Cache-Control": "private" } });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return Response.json({ code: error.message }, { status: 401 });
    logger.error("http.request.failed", { route: "/api/tasks/:taskId/images/:assetId", error });
    return Response.json({ code: "IMAGE_PREVIEW_FAILED" }, { status: 404 });
  }
}

