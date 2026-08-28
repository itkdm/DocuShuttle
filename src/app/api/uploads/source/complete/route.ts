import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { OoxmlPreservationKernel } from "@/modules/documents";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { CompleteSourceUpload } from "@/modules/uploads/complete-source-upload";

const schema = z.object({
  taskId: z.uuid(),
  role: z.enum(["template", "example", "auxiliary"]),
  originalName: z.string().min(1).max(255),
  objectKey: z.string().min(1).max(600),
  expectedBytes: z.number().int().positive(),
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const { client, userId } = await requireSupabaseIdentity();
    const result = await new CompleteSourceUpload(
      new SupabaseTaskRepository(client),
      new SupabaseStorageAdapter(client),
      new OoxmlPreservationKernel(),
    ).execute({ ...input, ownerUserId: userId });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    const code = error instanceof Error && "code" in error ? String(error.code) : error instanceof Error ? error.message : "COMPLETE_UPLOAD_FAILED";
    const clientCodes = new Set(["UPLOAD_SIZE_MISMATCH", "UPLOAD_CHECKSUM_MISMATCH", "OBJECT_SCOPE_MISMATCH", "INVALID_OBJECT_KEY"]);
    const status = code === "AUTHENTICATION_REQUIRED" ? 401 : code === "TASK_NOT_FOUND" ? 404 : clientCodes.has(code) || code.startsWith("DOCX_") ? 400 : 500;
    if (status === 500) logger.error("http.request.failed", { route: "/api/uploads/source/complete", error: { code } });
    return NextResponse.json({ code: status === 500 ? "COMPLETE_UPLOAD_FAILED" : code }, { status });
  }
}
