import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { AgentLoopRunner } from "@/modules/agent/application/loop";
import { createDocumentTools } from "@/modules/agent/application/document-tools";
import { createDocumentVersionTools } from "@/modules/agent/application/document-version-tools";
import { createSourceContextTools } from "@/modules/agent/application/source-context-tools";
import { createOpenAICompatibleAgentModelFromEnvironment } from "@/modules/agent/infrastructure/openai-compatible-model";
import { SupabaseAgentLoopStore } from "@/modules/agent/infrastructure/supabase/loop-persistence";
import { SupabaseWorkingDocumentAccess } from "@/modules/agent/infrastructure/supabase/working-document-access";
import { SupabaseDocumentVersionAccess } from "@/modules/agent/infrastructure/supabase/document-version-access";
import { SupabaseSourceDocumentContext } from "@/modules/agent/infrastructure/supabase/source-context";
import { OoxmlPreservationKernel } from "@/modules/documents";

const schema = z.object({ approval: z.enum(["approved", "rejected"]) });
const eventPayload = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function createRunner(runId: string) {
  const { client } = await requireSupabaseUser();
  const run = await client.from("agent_runs").select("task_id").eq("id", runId).single();
  if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
  const kernel = new OoxmlPreservationKernel();
  const taskId = run.data.task_id as string;
  const tools = [
    ...createDocumentTools(kernel, new SupabaseWorkingDocumentAccess(client, taskId, runId)),
    ...createSourceContextTools(taskId, new SupabaseSourceDocumentContext(client), kernel),
    ...createDocumentVersionTools(new SupabaseDocumentVersionAccess(client, taskId)),
  ];
  return new AgentLoopRunner(createOpenAICompatibleAgentModelFromEnvironment(), new SupabaseAgentLoopStore(client), tools);
}

async function runResume(request: Request, runId: string, stream: boolean) {
  const input = schema.parse(await request.json());
  const runner = await createRunner(runId);
  if (!stream) return NextResponse.json(await runner.resume(runId, input.approval, request.signal));
  const encoder = new TextEncoder();
  const responseStream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(eventPayload(event, data)));
      try {
        const result = await runner.resume(runId, input.approval, request.signal, (event) => send("event", event));
        send("result", result);
      } catch (error) {
        send("error", { code: error instanceof Error ? error.message : "AGENT_LOOP_RESUME_FAILED" });
      } finally { controller.close(); }
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
    console.error("agent_loop_resume_failed", error instanceof Error ? error.message : "unknown");
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
    console.error("agent_loop_resume_stream_failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ code: error instanceof Error ? error.message : "AGENT_LOOP_RESUME_FAILED" }, { status: 500 });
  }
}
