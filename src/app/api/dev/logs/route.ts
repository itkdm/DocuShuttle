import { NextResponse } from "next/server";
import { logger } from "@/infrastructure/observability";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const payload = await request.json().catch(() => ({})) as { events?: unknown[] };
  logger.info("client.logs.received", { count: Array.isArray(payload.events) ? payload.events.length : 0 });
  return NextResponse.json({ accepted: true });
}
