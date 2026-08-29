import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { createImageGenerationProviderFromEnvironment } from "@/modules/generation/adapters/factory";
import { GenerateImageCandidates, generateImageCandidatesInputSchema, ImageGenerationInputError, RemoteImageFetcher } from "@/modules/generation/application/generate-image-candidates";
import { SupabaseGeneratedAssetStore } from "@/modules/generation/infrastructure/supabase-generated-asset-store";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params;
    const { client, userId } = await requireSupabaseIdentity();
    const body = generateImageCandidatesInputSchema.parse({ ...(await request.json()), taskId });
    const result = await new GenerateImageCandidates(
      new SupabaseTaskRepository(client),
      createImageGenerationProviderFromEnvironment(),
      new SupabaseStorageAdapter(client),
      new SupabaseGeneratedAssetStore(client),
      new RemoteImageFetcher(),
    ).execute({ ...body, ownerUserId: userId });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError || error instanceof ImageGenerationInputError) {
      return NextResponse.json({ code: "INVALID_IMAGE_REQUEST", message: error instanceof ZodError ? "Invalid image request." : error.message }, { status: 400 });
    }
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    logger.error("http.request.failed", { route: "/api/tasks/:taskId/images", error });
    return NextResponse.json({ code: "IMAGE_GENERATION_FAILED" }, { status: 502 });
  }
}
