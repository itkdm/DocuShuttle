import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { OoxmlPreservationKernel } from "@/modules/documents";
import { sha256 } from "@/modules/documents/infrastructure/ooxml/hash";
import { buildTaskObjectKey } from "@/modules/storage/object-key";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { CompleteSourceUpload } from "@/modules/uploads/complete-source-upload";

const metadata = z.object({
  taskId: z.uuid(),
  role: z.enum(["template", "example", "auxiliary"]),
  originalName: z.string().min(1).max(255),
});
const maxProxyBytes = 4 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const input = metadata.parse({ taskId: form.get("taskId"), role: form.get("role"), originalName: form.get("originalName") });
    const file = form.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".docx")) return NextResponse.json({ code: "DOCX_REQUIRED" }, { status: 400 });
    if (file.size < 1 || file.size > maxProxyBytes) return NextResponse.json({ code: "PROXY_UPLOAD_LIMIT" }, { status: 413 });

    const { client, user } = await requireSupabaseUser();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checksum = await sha256(bytes);
    const objectKey = buildTaskObjectKey({ userId: user.id, taskId: input.taskId, category: "sources", fileName: `${crypto.randomUUID()}.docx` });
    const storage = new SupabaseStorageAdapter(client);
    await storage.put(objectKey, bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const result = await new CompleteSourceUpload(new SupabaseTaskRepository(client), storage, new OoxmlPreservationKernel()).execute({
      ...input, ownerUserId: user.id, objectKey, expectedBytes: bytes.byteLength, expectedSha256: checksum,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const code = error instanceof z.ZodError ? "INVALID_REQUEST" : error instanceof Error ? error.message : "PROXY_UPLOAD_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" ? 401 : code === "TASK_NOT_FOUND" ? 404 : code === "INVALID_REQUEST" ? 400 : 500;
    if (status === 500) logger.error("http.request.failed", { route: "/api/uploads/source/proxy", error: { code } });
    return NextResponse.json({ code: status === 500 ? "PROXY_UPLOAD_FAILED" : code }, { status });
  }
}
