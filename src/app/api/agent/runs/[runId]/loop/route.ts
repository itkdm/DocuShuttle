import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { AgentLoopRunner, type AgentPermissionMode } from "@/modules/agent/application/loop";
import { createDocumentTools } from "@/modules/agent/application/document-tools";
import { createDocumentVersionTools } from "@/modules/agent/application/document-version-tools";
import { createSourceContextTools } from "@/modules/agent/application/source-context-tools";
import { createOpenAICompatibleAgentModelFromEnvironment } from "@/modules/agent/infrastructure/openai-compatible-model";
import { SupabaseAgentLoopStore } from "@/modules/agent/infrastructure/supabase/loop-persistence";
import { SupabaseWorkingDocumentAccess } from "@/modules/agent/infrastructure/supabase/working-document-access";
import { SupabaseDocumentVersionAccess } from "@/modules/agent/infrastructure/supabase/document-version-access";
import { SupabaseSourceDocumentContext } from "@/modules/agent/infrastructure/supabase/source-context";
import { OoxmlPreservationKernel } from "@/modules/documents";
import { logger, withLogContext } from "@/infrastructure/observability";

const schema = z.object({
  message: z.string().trim().min(1).max(8_000),
  permissionMode: z.enum(["default", "full"]).optional().default("default"),
  clientMessageId: z.uuid().optional(),
});

const eventPayload = (event: string, data: unknown) => {
  const id = event === "event" && data && typeof data === "object" && typeof (data as { eventId?: unknown }).eventId === "string"
    ? `id: ${(data as { eventId: string }).eventId}\n` : "";
  return `${id}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
};

async function createRunner(runId: string) {
  const { client } = await requireSupabaseUser();
  const run = await client.from("agent_runs").select("task_id").eq("id", runId).single();
  if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
  const kernel = new OoxmlPreservationKernel();
  const taskId = run.data.task_id as string;
  const tools = [
    ...createDocumentTools(kernel, new SupabaseWorkingDocumentAccess(client, taskId, runId), ({ event, metadata }) => logger.info(event, { ...metadata, runId, taskId })),
    ...createSourceContextTools(taskId, new SupabaseSourceDocumentContext(client), kernel),
    ...createDocumentVersionTools(new SupabaseDocumentVersionAccess(client, taskId)),
  ];
  return new AgentLoopRunner(createOpenAICompatibleAgentModelFromEnvironment(), new SupabaseAgentLoopStore(client), tools, 24, 48, 30_000, undefined, 30_000, ({ event, metadata }) => logger.info(event, metadata));
}

async function persistAskUserAnswer(runId: string, message: string, clientMessageId?: string) {
  if (!clientMessageId) return;
  const { client, user } = await requireSupabaseUser();
  const run = await client.from("agent_runs").select("state, owner_user_id").eq("id", runId).eq("owner_user_id", user.id).single();
  if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
  const checkpoint = (run.data.state as { loopCheckpoint?: { pendingUserQuestion?: unknown; conversationId?: string } } | null)?.loopCheckpoint;
  if (!checkpoint?.pendingUserQuestion || !checkpoint.conversationId) return;
  const inserted = await client.from("messages").upsert({
    id: clientMessageId,
    owner_user_id: user.id,
    conversation_id: checkpoint.conversationId,
    role: "user",
    parts: [{ type: "text", text: message }],
    run_id: runId,
    message_key: clientMessageId,
    delivery_status: "sent",
  }, { onConflict: "conversation_id,message_key", ignoreDuplicates: true });
  if (inserted.error) throw new Error(`Unable to persist user answer: ${inserted.error.message}`);
}

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { runId } = await params;
  return withLogContext({ requestId }, async () => {
    const started = performance.now();
  try {
    const { client } = await requireSupabaseUser();
    const checkpoint = await new SupabaseAgentLoopStore(client).load(runId);
    if (!checkpoint) return NextResponse.json({ code: "LOOP_NOT_FOUND" }, { status: 404 });
    const url = new URL(request.url);
    const after = Number(url.searchParams.get("after") ?? "0");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "200"), 1), 500);
    const durable = await client.from("agent_run_events").select("sequence, event").eq("run_id", runId).gt("sequence", Number.isFinite(after) ? after : 0).order("sequence", { ascending: true }).limit(limit);
    if (durable.error) throw new Error(durable.error.message);
    const events = (durable.data ?? []).map((row) => {
      const event = row.event && typeof row.event === "object" ? row.event as Record<string, unknown> : undefined;
      return event ? { ...event, sequence: row.sequence, runId } : undefined;
    }).filter((event) => Boolean(event));
    const response = NextResponse.json({ checkpoint, events, nextSequence: durable.data?.at(-1)?.sequence ?? after });
    logger.info("agent.replay.completed", { runId, afterSequence: after, limit, durableEventCount: durable.data?.length ?? 0, returnedEventCount: events.length, nextSequence: durable.data?.at(-1)?.sequence ?? after, durationMs: performance.now() - started });
    logger.info("http.request.completed", { method: "GET", route: "/api/agent/runs/:runId/loop", status: response.status, durationMs: performance.now() - started, runId, afterSequence: after, durableEventCount: durable.data?.length ?? 0, returnedEventCount: events.length });
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    logger.error("http.request.failed", { method: "GET", route: "/api/agent/runs/:runId/loop", durationMs: performance.now() - started, runId, error });
    return NextResponse.json({ code: "AGENT_LOOP_LOAD_FAILED" }, { status: 500 });
  }
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { runId } = await params;
  return withLogContext({ requestId }, async () => {
    const started = performance.now();
  try {
    const input = schema.parse(await request.json());
    await persistAskUserAnswer(runId, input.message, input.clientMessageId);
    const result = await (await createRunner(runId)).runWithPermission(runId, input.message, input.permissionMode as AgentPermissionMode, undefined, undefined, input.clientMessageId);
    const response = NextResponse.json(result);
    logger.info("http.request.completed", { method: "POST", route: "/api/agent/runs/:runId/loop", status: response.status, durationMs: performance.now() - started, runId });
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    logger.error("http.request.failed", { method: "POST", route: "/api/agent/runs/:runId/loop", durationMs: performance.now() - started, runId, error });
    return NextResponse.json({ code: "AGENT_LOOP_FAILED" }, { status: 500 });
  }
  });
}

/** POST with fetch streaming: emits public text deltas and audit-safe tool lifecycle events. */
export async function PUT(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { runId } = await params;
  return withLogContext({ requestId }, async () => {
    const started = performance.now();
  try {
    const input = schema.parse(await request.json());
    await persistAskUserAnswer(runId, input.message, input.clientMessageId);
    const runner = await createRunner(runId);
    const encoder = new TextEncoder();
    let eventCount = 0;
    let bytesSent = 0;
    let firstEventMs: number | undefined;
    let streamFailed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const heartbeat = setInterval(() => {
          if (!request.signal.aborted) controller.enqueue(encoder.encode(": ping\n\n"));
        }, 12_000);
        const send = (event: string, data: unknown) => {
          const payload = encoder.encode(eventPayload(event, data));
          firstEventMs ??= performance.now() - started;
          eventCount += 1;
          bytesSent += payload.byteLength;
          controller.enqueue(payload);
        };
        try {
          const result = await runner.runWithPermission(runId, input.message, input.permissionMode as AgentPermissionMode, request.signal, (event) => send("event", event), input.clientMessageId);
          send("result", result);
        } catch (error) {
          streamFailed = true;
          send("error", { code: error instanceof Error ? error.message : "AGENT_LOOP_FAILED" });
        } finally {
          clearInterval(heartbeat);
          logger.info(streamFailed || request.signal.aborted ? "agent.stream.failed" : "agent.stream.completed", { runId, firstEventMs, eventCount, bytesSent, aborted: request.signal.aborted, completed: !streamFailed && !request.signal.aborted });
          controller.close();
        }
      },
    });
    logger.info("http.request.started", { method: "PUT", route: "/api/agent/runs/:runId/loop", runId, streaming: true });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "connection": "keep-alive", "x-accel-buffering": "no" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    return NextResponse.json({ code: error instanceof Error ? error.message : "AGENT_LOOP_FAILED" }, { status: 500 });
  }
  });
}
