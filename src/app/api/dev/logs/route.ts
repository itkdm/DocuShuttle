import { NextResponse } from "next/server";
import { logger } from "@/infrastructure/observability";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const payload = await request.json().catch(() => ({})) as { events?: unknown[] };
  const allowed = new Set(["client.fetch.completed", "client.fetch.failed", "client.sse.completed", "client.sse.failed"]);
  const events = Array.isArray(payload.events) ? payload.events : [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    if (typeof record.event !== "string" || !allowed.has(record.event)) continue;
    const metadata = Object.fromEntries(Object.entries(record).filter(([key, value]) => key !== "event" && ["string", "number", "boolean"].includes(typeof value)));
    logger.info(record.event, metadata);
  }
  logger.info("client.logs.received", { count: events.length });
  return NextResponse.json({ accepted: true });
}
