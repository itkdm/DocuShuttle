import { NextResponse } from "next/server";
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { CreateTask } from "@/modules/tasks/create-task";
import { ListTasks } from "@/modules/tasks/list-tasks";

const requestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().max(8_000).default(""),
});

export async function GET() {
  const started = performance.now();
  try {
    const { client, user } = await requireSupabaseUser();
    const tasks = await new ListTasks(new SupabaseTaskRepository(client)).execute(user.id);
    logger.info("tasks.list.completed", { durationMs: performance.now() - started, taskCount: tasks.length });
    return NextResponse.json({ tasks });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") {
      return NextResponse.json({ code: error.message }, { status: 401 });
    }
    logger.error("http.request.failed", { route: "/api/tasks", durationMs: performance.now() - started, error });
    return NextResponse.json({ code: "LIST_TASKS_FAILED" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    const { client, user } = await requireSupabaseUser();
    const task = await new CreateTask(new SupabaseTaskRepository(client)).execute({
      ownerUserId: user.id,
      title: input.title,
      goal: input.goal,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    }
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") {
      return NextResponse.json({ code: error.message }, { status: 401 });
    }
    logger.error("http.request.failed", { route: "/api/tasks", error });
    return NextResponse.json({ code: "CREATE_TASK_FAILED" }, { status: 500 });
  }
}
