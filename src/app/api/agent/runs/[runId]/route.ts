import { NextResponse } from "next/server";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { SupabaseAgentRunStore } from "@/modules/agent/infrastructure/supabase/runtime-persistence";
import { agentErrorResponse } from "../../http";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const { client } = await requireSupabaseIdentity();
    const run = await new SupabaseAgentRunStore(client).load(runId);
    if (!run) return NextResponse.json({ code: "RUN_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
