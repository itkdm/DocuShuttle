import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { CreateUploadedImageAsset, MAX_UPLOADED_IMAGE_BYTES } from "@/modules/uploads/uploaded-image-asset";
import { SupabaseImageAssetStore } from "@/modules/uploads/supabase-image-asset-store";

const metadata = z.object({ taskId: z.uuid() });

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const { taskId } = metadata.parse({ taskId: form.get("taskId") });
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ code: "IMAGE_REQUIRED" }, { status: 400 });
    if (file.size < 1 || file.size > MAX_UPLOADED_IMAGE_BYTES) return NextResponse.json({ code: "IMAGE_SIZE_OUT_OF_RANGE" }, { status: 400 });
    const { client, userId } = await requireSupabaseIdentity();
    const result = await new CreateUploadedImageAsset(new SupabaseTaskRepository(client), new SupabaseStorageAdapter(client), new SupabaseImageAssetStore(client)).execute({ ownerUserId: userId, taskId, bytes: new Uint8Array(await file.arrayBuffer()), declaredMimeType: file.type || undefined });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
    const code = error instanceof Error ? error.message : "IMAGE_UPLOAD_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" ? 401 : code === "TASK_NOT_FOUND" ? 404 : ["IMAGE_REQUIRED", "IMAGE_SIZE_OUT_OF_RANGE", "IMAGE_TYPE_UNSUPPORTED"].includes(code) ? 400 : 500;
    return NextResponse.json({ code: status === 500 ? "IMAGE_UPLOAD_FAILED" : code }, { status });
  }
}
