import { NextResponse } from "next/server";
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { GetTaskWorkspace } from "@/modules/tasks/get-task-workspace";

const paramsSchema = z.object({ taskId: z.uuid() });

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const started = performance.now();
  try {
    const { taskId } = paramsSchema.parse(await params);
    const { client, user } = await requireSupabaseUser();
    const workspace = await new GetTaskWorkspace(new SupabaseTaskRepository(client)).execute({
      taskId,
      ownerUserId: user.id,
    });
    if (!workspace) {
      logger.warn("tasks.workspace.not_found", { taskId, durationMs: performance.now() - started });
      return NextResponse.json({ code: "TASK_NOT_FOUND" }, { status: 404 });
    }
    logger.info("tasks.workspace.completed", { taskId, durationMs: performance.now() - started, sourceCount: workspace.sources.length, hasWorkingDocument: Boolean(workspace.workingDocumentId), latestRunId: workspace.latestRunId });
    return NextResponse.json({ workspace });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    }
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") {
      return NextResponse.json({ code: error.message }, { status: 401 });
    }
    logger.error("http.request.failed", { route: "/api/tasks/:taskId", durationMs: performance.now() - started, error });
    return NextResponse.json({ code: "GET_TASK_FAILED" }, { status: 500 });
  }
}
