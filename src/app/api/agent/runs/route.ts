import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseAgentRunStore } from "@/modules/agent/infrastructure/supabase/runtime-persistence";
import { agentErrorResponse } from "../http";

const schema = z.object({ taskId: z.uuid(), goal: z.string().trim().min(1).max(8_000) });

export async function GET(request: Request) {
  try {
    const taskId = z.uuid().parse(new URL(request.url).searchParams.get("taskId"));
    const { client } = await requireSupabaseUser();
    const result = await client
      .from("agent_runs")
      .select("id, state, status, created_at, updated_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true })
      .limit(20);
    if (result.error) throw new Error(`Unable to load task agent runs: ${result.error.message}`);
    const runs = (result.data ?? []).map((row) => {
      const state = (row.state ?? {}) as { loopCheckpoint?: { trace?: unknown[]; status?: string } };
      const checkpoint = state.loopCheckpoint;
      return {
        id: row.id as string,
        status: row.status as string,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
        checkpoint: checkpoint ? { status: checkpoint.status } : undefined,
        events: checkpoint?.trace ?? [],
      };
    });
    return NextResponse.json({ runs });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
    return agentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const { client, user } = await requireSupabaseUser();
    const updated = await client.from("tasks").update({ goal: input.goal, updated_at: new Date().toISOString() })
      .eq("id", input.taskId).eq("owner_user_id", user.id).select("id").single();
    if (updated.error || !updated.data) return NextResponse.json({ code: "TASK_NOT_FOUND" }, { status: 404 });
    const run = await new SupabaseAgentRunStore(client).createForTask({
      taskId: input.taskId,
      ownerUserId: user.id,
      now: new Date().toISOString(),
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
