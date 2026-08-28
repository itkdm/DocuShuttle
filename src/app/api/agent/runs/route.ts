import { NextResponse } from "next/server";
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { SupabaseAgentRunStore } from "@/modules/agent/infrastructure/supabase/runtime-persistence";
import { isDurableAgentEvent, type DurableAgentEvent } from "@/modules/agent/application/events";
import { agentErrorResponse } from "../http";

const schema = z.object({ taskId: z.uuid(), goal: z.string().trim().min(1).max(8_000), clientMessageId: z.uuid().optional() });

export async function GET(request: Request) {
  const started = performance.now();
  try {
    const taskId = z.uuid().parse(new URL(request.url).searchParams.get("taskId"));
    const { client } = await requireSupabaseIdentity();
    const result = await client
      .from("agent_runs")
      .select("id, state, status, created_at, updated_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true });
    if (result.error) throw new Error(`Unable to load task agent runs: ${result.error.message}`);
    const rows = result.data ?? [];
    const eventResult = rows.length
      ? await client.from("agent_run_events").select("run_id, sequence, event").in("run_id", rows.map((row) => row.id)).order("sequence", { ascending: true })
      : { data: [], error: null };
    if (eventResult.error) throw new Error(`Unable to load task agent events: ${eventResult.error.message}`);
    const eventsByRun = new Map<string, DurableAgentEvent[]>();
    for (const row of eventResult.data ?? []) {
      const event = row.event && typeof row.event === "object"
        ? { ...(row.event as Record<string, unknown>), sequence: row.sequence, runId: row.run_id }
        : undefined;
      if (!isDurableAgentEvent(event)) continue;
      const list = eventsByRun.get(row.run_id as string) ?? [];
      list.push(event); eventsByRun.set(row.run_id as string, list);
    }
    const runs = rows.map((row) => {
      const state = (row.state ?? {}) as { loopCheckpoint?: { status?: string } };
      const checkpoint = state.loopCheckpoint;
      return {
        id: row.id as string,
        status: row.status as string,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
        checkpoint: checkpoint ? { status: checkpoint.status } : undefined,
        events: eventsByRun.get(row.id as string) ?? [],
      };
    });
    const response = NextResponse.json({ runs });
    logger.info("agent.runs.list.completed", { durationMs: performance.now() - started, taskId, runCount: runs.length, eventCount: runs.reduce((count, run) => count + run.events.length, 0) });
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
    logger.error("http.request.failed", { route: "/api/agent/runs", durationMs: performance.now() - started, error });
    return agentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const started = performance.now();
  try {
    const input = schema.parse(await request.json());
    const { client, userId } = await requireSupabaseIdentity();
    // The database RPC owns the active-run guard, stale lease reclaim, working
    // document/revision lookup, conversation identity, and atomic turn insert.
    // Keeping these reads in one transaction removes the fresh-run RTT chain.
    const run = await new SupabaseAgentRunStore(client).createForTask({
      taskId: input.taskId,
      ownerUserId: userId,
      now: new Date().toISOString(),
      goal: input.goal,
      clientMessageId: input.clientMessageId,
    });
    logger.info("agent.run_create.completed", { taskId: input.taskId, durationMs: performance.now() - started, userId });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && ["CONCURRENT_TURN", "TURN_NOT_ALLOWED"].includes(error.message)) {
      return NextResponse.json({ code: "TURN_NOT_ALLOWED", message: "当前对话已有一轮请求正在处理，请稍后继续。" }, { status: 409 });
    }
    return agentErrorResponse(error);
  }
}
