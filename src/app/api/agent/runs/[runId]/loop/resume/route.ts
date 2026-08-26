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

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const input = schema.parse(await request.json());
    const { runId } = await params;
    const { client } = await requireSupabaseUser();
    const run = await client.from("agent_runs").select("task_id").eq("id", runId).single();
    if (run.error || !run.data) return NextResponse.json({ code: "RUN_NOT_FOUND" }, { status: 404 });
    const kernel = new OoxmlPreservationKernel();
    const taskId = run.data.task_id as string;
    const tools = [
      ...createDocumentTools(kernel, new SupabaseWorkingDocumentAccess(client, taskId, runId)),
      ...createSourceContextTools(taskId, new SupabaseSourceDocumentContext(client), kernel),
      ...createDocumentVersionTools(new SupabaseDocumentVersionAccess(client, taskId)),
    ];
    const runner = new AgentLoopRunner(
      createOpenAICompatibleAgentModelFromEnvironment(),
      new SupabaseAgentLoopStore(client),
      tools,
    );
    return NextResponse.json(await runner.resume(runId, input.approval));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    console.error("agent_loop_resume_failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ code: "AGENT_LOOP_RESUME_FAILED" }, { status: 500 });
  }
}
