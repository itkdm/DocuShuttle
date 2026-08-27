import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { GetTaskWorkspace } from "@/modules/tasks/get-task-workspace";

const paramsSchema = z.object({ taskId: z.uuid() });

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = paramsSchema.parse(await params);
    const { client, user } = await requireSupabaseUser();
    const workspace = await new GetTaskWorkspace(new SupabaseTaskRepository(client)).execute({
      taskId,
      ownerUserId: user.id,
    });
    if (!workspace) return NextResponse.json({ code: "TASK_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ workspace });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    }
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") {
      return NextResponse.json({ code: error.message }, { status: 401 });
    }
    logger.error("http.request.failed", { route: "/api/tasks/:taskId", error });
    return NextResponse.json({ code: "GET_TASK_FAILED" }, { status: 500 });
  }
}
