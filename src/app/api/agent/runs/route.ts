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
      // Fetch the most recent runs first so the bounded history window is
      // useful for long-lived tasks. Restore chronological order in the
      // response; the UI can concatenate runs directly into one timeline.
      .order("created_at", { ascending: false })
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
    return NextResponse.json({ runs: runs.reverse() });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
    return agentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const { client, user } = await requireSupabaseUser();
    // Do not allocate a new immutable run while the conversation has a
    // durable HITL boundary. Approval and ask_user answers must continue the
    // existing run/checkpoint; creating here would fork and lose context.
    const latest = await client.from("agent_runs")
      .select("id, state, status")
      .eq("task_id", input.taskId)
      .eq("owner_user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest.error) throw new Error(`Unable to inspect active agent run: ${latest.error.message}`);
    const checkpoint = (latest.data?.state as { loopCheckpoint?: { pendingApproval?: unknown; pendingUserQuestion?: unknown } } | null)?.loopCheckpoint;
    if (checkpoint?.pendingApproval || checkpoint?.pendingUserQuestion || [
      "queued", "analyzing", "awaiting_scope_confirmation", "generating", "applying", "validating", "awaiting_review",
    ].includes(latest.data?.status as string)) {
      return NextResponse.json({ code: "TURN_NOT_ALLOWED", runId: latest.data?.id }, { status: 409 });
    }
    const run = await new SupabaseAgentRunStore(client).createForTask({
      taskId: input.taskId,
      ownerUserId: user.id,
      now: new Date().toISOString(),
    });
    // Allocate the uniquely-guarded turn before changing task metadata. A
    // concurrent request that loses the active-run constraint must not
    // overwrite the conversation goal as a side effect of its failed turn.
    const updated = await client.from("tasks").update({ goal: input.goal, updated_at: new Date().toISOString() })
      .eq("id", input.taskId).eq("owner_user_id", user.id).select("id").single();
    if (updated.error || !updated.data) return NextResponse.json({ code: "TASK_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "CONCURRENT_TURN") {
      return NextResponse.json({ code: "TURN_NOT_ALLOWED", message: "当前对话已有一轮请求正在处理，请稍后继续。" }, { status: 409 });
    }
    return agentErrorResponse(error);
  }
}
