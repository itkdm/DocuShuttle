import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { createAgentRuntime } from "@/modules/agent/infrastructure/runtime-factory";
import { agentErrorResponse } from "../../../http";
import { SupabaseAgentLoopStore } from "@/modules/agent/infrastructure/supabase/loop-persistence";

const schema = z.object({ commandId: z.uuid() });

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const input = schema.parse(await request.json());
    const { client } = await requireSupabaseUser();
    const run = await createAgentRuntime(client, runId).cancel(runId, input.commandId);
    await new SupabaseAgentLoopStore(client).markCancelled?.(runId);
    return NextResponse.json({ run });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
