import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/infrastructure/observability";
import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { CreateDocumentPreviewAsset, MAX_DOCUMENT_PREVIEW_BYTES } from "@/modules/uploads/document-preview-asset";
import { SupabaseImageAssetStore } from "@/modules/uploads/supabase-image-asset-store";

const metadata = z.object({
  width: z.coerce.number().int().positive().max(10_000),
  height: z.coerce.number().int().positive().max(10_000),
  pageNumber: z.coerce.number().int().positive().max(10_000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await params;
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ code: "PREVIEW_REQUIRED" }, { status: 400 });
    if (file.size < 1 || file.size > MAX_DOCUMENT_PREVIEW_BYTES) return NextResponse.json({ code: "PREVIEW_SIZE_OUT_OF_RANGE" }, { status: 400 });
    const input = metadata.parse({ width: form.get("width"), height: form.get("height"), pageNumber: form.get("pageNumber") ?? undefined });
    const { client, userId } = await requireSupabaseIdentity();
    const runId = String(form.get("runId") ?? "");
    const interactionId = String(form.get("interactionId") ?? "");
    const callId = String(form.get("callId") ?? "");
    if (!z.uuid().safeParse(runId).success || !z.uuid().safeParse(interactionId).success || !callId) return NextResponse.json({ code: "CLIENT_TOOL_IDENTITY_INVALID" }, { status: 400 });
    const run = await client.from("agent_runs").select("id, task_id, status, state").eq("id", runId).eq("owner_user_id", userId).maybeSingle();
    if (run.error) throw new Error(run.error.message);
    if (!run.data || run.data.task_id !== taskId) throw new Error("CLIENT_TOOL_RUN_MISMATCH");
    if (run.data.status !== "awaiting_client") throw new Error("CLIENT_TOOL_NOT_PENDING");
    const checkpoint = (run.data.state as { loopCheckpoint?: { pendingInteraction?: { type?: string; interactionId?: string; callId?: string; toolName?: string; expectedRevision?: string } } } | null)?.loopCheckpoint;
    const pending = checkpoint?.pendingInteraction;
    if (!pending || pending.type !== "client_tool" || pending.interactionId !== interactionId || pending.callId !== callId || pending.toolName !== "capture_document_view" || !pending.expectedRevision) throw new Error("CLIENT_TOOL_INTERACTION_MISMATCH");
    const documents = {
      async getCurrentRevision(currentTaskId: string, ownerUserId: string) {
        const working = await client.from("working_documents").select("current_version_id").eq("task_id", currentTaskId).eq("owner_user_id", ownerUserId).maybeSingle();
        if (working.error || !working.data?.current_version_id) return undefined;
        const version = await client.from("document_versions").select("sha256").eq("id", working.data.current_version_id).eq("owner_user_id", ownerUserId).maybeSingle();
        if (version.error) throw new Error(version.error.message);
        return version.data?.sha256 as string | undefined;
      },
    };
    const imageAssets = new SupabaseImageAssetStore(client);
    const result = await new CreateDocumentPreviewAsset(new SupabaseTaskRepository(client), documents, new SupabaseStorageAdapter(client), imageAssets).execute({ ownerUserId: userId, taskId, runId, interactionId, callId, bytes: new Uint8Array(await file.arrayBuffer()), revision: pending.expectedRevision, ...input });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    const code = error instanceof Error ? error.message : "PREVIEW_UPLOAD_FAILED";
    const status = code === "TASK_NOT_FOUND" ? 404 : ["PREVIEW_REQUIRED", "PREVIEW_SIZE_OUT_OF_RANGE", "PREVIEW_TYPE_UNSUPPORTED", "PREVIEW_DIMENSION_INVALID", "DOCUMENT_REVISION_MISMATCH", "CLIENT_TOOL_IDENTITY_INVALID"].includes(code) ? 400 : ["CLIENT_TOOL_NOT_PENDING", "CLIENT_TOOL_RUN_MISMATCH", "CLIENT_TOOL_INTERACTION_MISMATCH", "PREVIEW_IDEMPOTENCY_CONFLICT"].includes(code) ? 409 : 500;
    if (status === 500) logger.error("http.request.failed", { route: "/api/tasks/:taskId/document/previews", error });
    return NextResponse.json({ code: status === 500 ? "PREVIEW_UPLOAD_FAILED" : code }, { status });
  }
}
