import { NextResponse } from "next/server";
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { SupabaseAgentRunStore } from "@/modules/agent/infrastructure/supabase/runtime-persistence";
import { AGENT_LEASE_MANAGED_STATUSES } from "@/modules/agent/application/loop";
import { isDurableAgentEvent, type DurableAgentEvent } from "@/modules/agent/application/events";
import { agentErrorResponse } from "../http";

const schema = z.object({ taskId: z.uuid(), goal: z.string().trim().min(1).max(8_000), clientMessageId: z.uuid().optional() });

export async function GET(request: Request) {
  const started = performance.now();
  try {
    const taskId = z.uuid().parse(new URL(request.url).searchParams.get("taskId"));
    const { client } = await requireSupabaseUser();
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
  try {
    const input = schema.parse(await request.json());
    const { client, user } = await requireSupabaseUser();
    // Do not allocate a new immutable run while the conversation has a
    // durable HITL boundary. Approval and ask_user answers must continue the
    // existing run/checkpoint; creating here would fork and lose context.
    const latest = await client.from("agent_runs")
      .select("id, state, status, lease_expires_at")
      .eq("task_id", input.taskId)
      .eq("owner_user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest.error) throw new Error(`Unable to inspect active agent run: ${latest.error.message}`);
    const checkpoint = (latest.data?.state as { loopCheckpoint?: { pendingInteraction?: unknown } } | null)?.loopCheckpoint;
    const activeStatus = [...AGENT_LEASE_MANAGED_STATUSES, "awaiting_approval", "awaiting_user", "awaiting_review"].includes(latest.data?.status as string);
    // HITL waits are intentionally lease-less: a user may take hours to
    // answer. Only an invocation phase can become stale and be reclaimed.
    const leaseManagedStatus = AGENT_LEASE_MANAGED_STATUSES.includes(latest.data?.status as typeof AGENT_LEASE_MANAGED_STATUSES[number]);
    const leaseExpired = leaseManagedStatus && latest.data?.lease_expires_at && new Date(latest.data.lease_expires_at as string).getTime() <= Date.now();
    if (leaseExpired && latest.data?.id) {
      const reclaimed = await client.rpc("reclaim_stale_agent_run", { p_run_id: latest.data.id });
      if (reclaimed.error) throw new Error(`Unable to reclaim stale agent run: ${reclaimed.error.message}`);
    } else if (checkpoint?.pendingInteraction || activeStatus) {
      return NextResponse.json({ code: "TURN_NOT_ALLOWED", runId: latest.data?.id }, { status: 409 });
    }
    const run = await new SupabaseAgentRunStore(client).createForTask({
      taskId: input.taskId,
      ownerUserId: user.id,
      now: new Date().toISOString(),
      goal: input.goal,
      clientMessageId: input.clientMessageId,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "CONCURRENT_TURN") {
      return NextResponse.json({ code: "TURN_NOT_ALLOWED", message: "当前对话已有一轮请求正在处理，请稍后继续。" }, { status: 409 });
    }
    return agentErrorResponse(error);
  }
}
