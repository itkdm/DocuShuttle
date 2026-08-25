import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseAgentRunStore } from "@/modules/agent/infrastructure/supabase/runtime-persistence";
import { agentErrorResponse } from "../http";

const schema = z.object({ taskId: z.uuid(), goal: z.string().trim().min(1).max(8_000) });

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
