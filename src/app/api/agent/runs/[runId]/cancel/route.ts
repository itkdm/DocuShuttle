import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { agentErrorResponse } from "../../../http";
import { SupabaseAgentLoopStore } from "@/modules/agent/infrastructure/supabase/loop-persistence";
import { SupabaseAgentRunStore } from "@/modules/agent/infrastructure/supabase/runtime-persistence";
import { createFileAgentExecutionTrace } from "@/modules/agent/infrastructure/trace/writer";

const schema = z.object({ commandId: z.uuid() });

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    schema.parse(await request.json());
    const { client } = await requireSupabaseIdentity();
    await new SupabaseAgentLoopStore(client).markCancelled?.(runId);
    const run = await new SupabaseAgentRunStore(client).load(runId);
    if (!run) return NextResponse.json({ code: "RUN_NOT_FOUND" }, { status: 404 });
    if (run.status === "cancelled") {
      const trace = createFileAgentExecutionTrace(runId);
      trace?.finishRun({ currentStatus: run.status, finalStatus: run.status, finishedAt: new Date().toISOString() });
      await trace?.flush();
    }
    return NextResponse.json({ run });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
