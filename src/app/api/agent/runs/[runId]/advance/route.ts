import { NextResponse } from "next/server";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { createAgentRuntime } from "@/modules/agent/infrastructure/runtime-factory";
import { agentErrorResponse } from "../../../http";

export async function POST(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const { client } = await requireSupabaseUser();
    const outcome = await createAgentRuntime(client, runId).advance(runId);
    return NextResponse.json(outcome);
  } catch (error) {
    return agentErrorResponse(error);
  }
}
