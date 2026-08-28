import { NextResponse } from "next/server";
import { logger } from "@/infrastructure/observability";
import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { AgentLoopRunner } from "@/modules/agent/application/loop";
import { projectAgentLoopResultForClient } from "@/modules/agent/application/public-runtime";
import { createDocumentTools } from "@/modules/agent/application/document-tools";
import { createDocumentVersionTools } from "@/modules/agent/application/document-version-tools";
import { createSourceContextTools } from "@/modules/agent/application/source-context-tools";
import { createOpenAICompatibleAgentModelFromEnvironment } from "@/modules/agent/infrastructure/openai-compatible-model";
import { SupabaseAgentLoopStore } from "@/modules/agent/infrastructure/supabase/loop-persistence";
import { SupabaseWorkingDocumentAccess } from "@/modules/agent/infrastructure/supabase/working-document-access";
import { SupabaseDocumentVersionAccess } from "@/modules/agent/infrastructure/supabase/document-version-access";
import { SupabaseSourceDocumentContext } from "@/modules/agent/infrastructure/supabase/source-context";
import { SupabaseAgentConversationContext } from "@/modules/agent/infrastructure/supabase/conversation-context";
import { OoxmlPreservationKernel } from "@/modules/documents";

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function createRunner(runId: string) {
  const { client } = await requireSupabaseIdentity();
  const row = await client.from("agent_runs").select("task_id").eq("id", runId).single();
  if (row.error || !row.data) throw new Error("RUN_NOT_FOUND");
  const kernel = new OoxmlPreservationKernel();
  const taskId = row.data.task_id as string;
  const loopStore = new SupabaseAgentLoopStore(client);
  const tools = [
    ...createDocumentTools(kernel, new SupabaseWorkingDocumentAccess(client, taskId, runId, () => loopStore.getOwnedLockVersion(runId)), ({ event, metadata }) => logger.info(event, { ...metadata, runId, taskId })),
    ...createSourceContextTools(taskId, new SupabaseSourceDocumentContext(client), kernel),
    ...createDocumentVersionTools(new SupabaseDocumentVersionAccess(client, taskId)),
  ];
  return new AgentLoopRunner(createOpenAICompatibleAgentModelFromEnvironment(), loopStore, tools, 24, 48, 30_000, undefined, 30_000, ({ event, metadata }) => logger.info(event, metadata), new SupabaseAgentConversationContext(client));
}

async function execute(request: Request, runId: string, stream: boolean) {
  const runner = await createRunner(runId);
  if (!stream) return NextResponse.json(projectAgentLoopResultForClient(await runner.recover(runId)));
  const encoder = new TextEncoder();
  const responseStream = new ReadableStream({
    async start(controller) {
      let open = true;
      const close = () => { if (!open) return; open = false; try { controller.close(); } catch { /* detached */ } };
      request.signal.addEventListener("abort", () => { open = false; }, { once: true });
      const send = (event: string, data: unknown) => { if (!open) return; try { controller.enqueue(encoder.encode(frame(event, data))); } catch { open = false; } };
      try {
        logger.info("agent.recovery.claimed", { runId });
        const result = await runner.recover(runId, request.signal, (event) => send("event", event));
        send("result", projectAgentLoopResultForClient(result));
        logger.info("agent.recovery.completed", { runId });
      } catch (error) {
        if (error instanceof Error && error.message === "RUN_STILL_ACTIVE") logger.info("agent.recovery.skipped", { runId, reason: error.message });
        else if (error instanceof Error && error.message === "TRANSPORT_INTERRUPTED") logger.info("agent.transport.detached", { runId });
        else if (open) send("error", { code: error instanceof Error ? error.message : "AGENT_LOOP_FAILED" });
      } finally { close(); }
    },
  });
  return new Response(responseStream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try { return await execute(request, (await params).runId, false); }
  catch (error) { return NextResponse.json({ code: error instanceof Error ? error.message : "AGENT_LOOP_FAILED" }, { status: 500 }); }
}

export async function PUT(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try { return await execute(request, (await params).runId, true); }
  catch (error) { return NextResponse.json({ code: error instanceof Error ? error.message : "AGENT_LOOP_FAILED" }, { status: 500 }); }
}
