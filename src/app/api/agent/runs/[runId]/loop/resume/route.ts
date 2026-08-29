import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/infrastructure/observability";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { AgentLoopRunner } from "@/modules/agent/application/loop";
import { projectAgentLoopResultForClient } from "@/modules/agent/application/public-runtime";
import { createDocumentTools } from "@/modules/agent/application/document-tools";
import { createDocumentVersionTools } from "@/modules/agent/application/document-version-tools";
import { createSourceContextTools } from "@/modules/agent/application/source-context-tools";
import { createImageInspectionTools } from "@/modules/agent/application/image-tools";
import { createOpenAICompatibleAgentModelFromEnvironment } from "@/modules/agent/infrastructure/openai-compatible-model";
import { createImageVisionFromEnvironment } from "@/modules/agent/infrastructure/openai-compatible-vision";
import { SupabaseAgentLoopStore } from "@/modules/agent/infrastructure/supabase/loop-persistence";
import { SupabaseWorkingDocumentAccess } from "@/modules/agent/infrastructure/supabase/working-document-access";
import { SupabaseDocumentVersionAccess } from "@/modules/agent/infrastructure/supabase/document-version-access";
import { SupabaseSourceDocumentContext } from "@/modules/agent/infrastructure/supabase/source-context";
import { SupabaseAgentConversationContext } from "@/modules/agent/infrastructure/supabase/conversation-context";
import { OoxmlPreservationKernel } from "@/modules/documents";

const schema = z.object({ approval: z.enum(["approved", "rejected"]), interactionId: z.uuid(), callId: z.string().trim().min(1).max(200) });
const eventPayload = (event: string, data: unknown) => {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
};

async function createRunner(runId: string) {
  const { client } = await requireSupabaseIdentity();
  const run = await client.from("agent_runs").select("task_id").eq("id", runId).single();
  if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
  const kernel = new OoxmlPreservationKernel();
  const taskId = run.data.task_id as string;
  const loopStore = new SupabaseAgentLoopStore(client);
  const working = new SupabaseWorkingDocumentAccess(client, taskId, runId, () => loopStore.getOwnedLockVersion(runId));
  const sources = new SupabaseSourceDocumentContext(client);
  const tools = [
    ...createDocumentTools(kernel, working, ({ event, metadata }) => logger.info(event, { ...metadata, runId, taskId })),
    ...createSourceContextTools(taskId, sources, kernel),
    ...createImageInspectionTools(taskId, kernel, working, sources, createImageVisionFromEnvironment()),
    ...createDocumentVersionTools(new SupabaseDocumentVersionAccess(client, taskId)),
  ];
  return new AgentLoopRunner(createOpenAICompatibleAgentModelFromEnvironment(), loopStore, tools, 24, 48, 30_000, undefined, 30_000, ({ event, metadata }) => logger.info(event, metadata), new SupabaseAgentConversationContext(client));
}

async function runResume(request: Request, runId: string, stream: boolean) {
  const input = schema.parse(await request.json());
  const runner = await createRunner(runId);
  if (!stream) return NextResponse.json(projectAgentLoopResultForClient(await runner.resume(runId, input.approval, input.interactionId, input.callId, request.signal)));
  const encoder = new TextEncoder();
  const responseStream = new ReadableStream({
    async start(controller) {
      let open = true;
      const close = () => { if (!open) return; open = false; try { controller.close(); } catch { /* detached */ } };
      request.signal.addEventListener("abort", () => { open = false; }, { once: true });
      const send = (event: string, data: unknown) => { if (!open) return; try { controller.enqueue(encoder.encode(eventPayload(event, data))); } catch { open = false; } };
      try {
        const result = await runner.resume(runId, input.approval, input.interactionId, input.callId, request.signal, (event) => send("event", event));
        send("result", projectAgentLoopResultForClient(result));
      } catch (error) {
        if (open) send("error", { code: error instanceof Error ? error.message : "AGENT_LOOP_RESUME_FAILED" });
      } finally { close(); }
    },
  });
  return new Response(responseStream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    return await runResume(request, runId, false);
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    if (error instanceof Error && error.message === "No pending agent approval") {
      return NextResponse.json({ code: "APPROVAL_NOT_PENDING" }, { status: 409 });
    }
    if (error instanceof Error && ["APPROVAL_ALREADY_CLAIMED", "APPROVAL_INTERACTION_MISMATCH", "APPROVAL_RESOLUTION_MISMATCH", "RUN_CANCELLED"].includes(error.message)) return NextResponse.json({ code: error.message }, { status: 409 });
    logger.error("http.request.failed", { route: "/api/agent/runs/:runId/loop/resume", error });
    return NextResponse.json({ code: "AGENT_LOOP_RESUME_FAILED" }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    return await runResume(request, runId, true);
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    if (error instanceof Error && error.message === "No pending agent approval") return NextResponse.json({ code: "APPROVAL_NOT_PENDING" }, { status: 409 });
    if (error instanceof Error && ["APPROVAL_ALREADY_CLAIMED", "APPROVAL_INTERACTION_MISMATCH", "APPROVAL_RESOLUTION_MISMATCH", "RUN_CANCELLED"].includes(error.message)) return NextResponse.json({ code: error.message }, { status: 409 });
    logger.error("http.request.failed", { route: "/api/agent/runs/:runId/loop/resume", error });
    return NextResponse.json({ code: error instanceof Error ? error.message : "AGENT_LOOP_RESUME_FAILED" }, { status: 500 });
  }
}
