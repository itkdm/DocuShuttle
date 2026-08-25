import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseUser } from "@/infrastructure/supabase/server";
import { createAgentRuntime } from "@/modules/agent/infrastructure/runtime-factory";
import { agentErrorResponse } from "../../../http";

const schema = z.object({
  commandId: z.uuid(),
  decisionId: z.uuid(),
  choice: z.enum(["approved", "rejected"]),
  reviewedRevision: z.string().regex(/^[0-9a-f]{64}$/),
});

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const input = schema.parse(await request.json());
    const { client, user } = await requireSupabaseUser();
    const run = await createAgentRuntime(client, runId).completeReview(runId, { ...input, decidedBy: user.id });
    return NextResponse.json({ run });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
