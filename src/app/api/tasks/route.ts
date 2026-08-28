import { NextResponse } from "next/server";
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { CreateTask } from "@/modules/tasks/create-task";
import { ListTasks } from "@/modules/tasks/list-tasks";

const requestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().max(8_000).default(""),
});

const listQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(request: Request) {
  const started = performance.now();
  try {
    const query = listQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { client, userId } = await requireSupabaseIdentity();
    const tasks = await new ListTasks(new SupabaseTaskRepository(client)).execute(userId, { limit: query.limit + 1, offset: query.offset });
    const hasMore = tasks.length > query.limit;
    logger.info("tasks.list.completed", { durationMs: performance.now() - started, taskCount: Math.min(tasks.length, query.limit), offset: query.offset, limit: query.limit, hasMore });
    return NextResponse.json({ tasks: tasks.slice(0, query.limit), nextOffset: hasMore ? query.offset + query.limit : null, hasMore });
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
    const { client, userId } = await requireSupabaseIdentity();
    const task = await new CreateTask(new SupabaseTaskRepository(client)).execute({
      ownerUserId: userId,
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
