import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseTaskRepository } from "@/modules/tasks/adapters/supabase-task-repository";
import { CreateTask } from "@/modules/tasks/create-task";

const requestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().max(8_000).default(""),
});

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
    console.error("create_task_failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ code: "CREATE_TASK_FAILED" }, { status: 500 });
  }
}
