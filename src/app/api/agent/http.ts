import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { AgentDomainError } from "@/modules/agent";

export const agentErrorResponse = (error: unknown) => {
  if (error instanceof ZodError) {
    return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
  }
  if (error instanceof AgentDomainError) {
    const status = error.code === "RUN_NOT_FOUND" ? 404
      : error.code === "STALE_DOCUMENT_REVISION" || error.code.includes("CONFLICT") ? 409
        : 400;
    return NextResponse.json({ code: error.code, message: error.message }, { status });
  }
  if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") {
    return NextResponse.json({ code: error.message }, { status: 401 });
  }
  console.error("agent_request_failed", error instanceof Error ? error.message : "unknown");
  return NextResponse.json({ code: "AGENT_REQUEST_FAILED" }, { status: 500 });
};
