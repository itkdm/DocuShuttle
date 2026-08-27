import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { CreateSourceUpload } from "@/modules/uploads/create-source-upload";

const schema = z.object({
  taskId: z.uuid(),
  role: z.enum(["template", "example", "auxiliary"]),
  originalName: z.string().min(1).max(255),
  byteLength: z.number().int().positive(),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const { client, user } = await requireSupabaseUser();
    const result = await new CreateSourceUpload(
      new SupabaseTaskRepository(client),
      new SupabaseStorageAdapter(client),
    ).execute({ ...input, ownerUserId: user.id });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    const code = error instanceof Error ? error.message : "SIGN_UPLOAD_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" ? 401 : code === "TASK_NOT_FOUND" ? 404 : code === "DOCX_REQUIRED" || code === "FILE_SIZE_OUT_OF_RANGE" ? 400 : 500;
    if (status === 500) logger.error("http.request.failed", { route: "/api/uploads/source/sign", error: { code } });
    return NextResponse.json({ code: status === 500 ? "SIGN_UPLOAD_FAILED" : code }, { status });
  }
}
