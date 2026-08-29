import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSupabaseIdentity } from "@/infrastructure/supabase/server";
import { AgentLoopRunner, type AgentPermissionMode } from "@/modules/agent/application/loop";
import { projectAgentLoopCheckpointForClient, projectAgentLoopResultForClient } from "@/modules/agent/application/public-runtime";
import { isDurableAgentEvent } from "@/modules/agent/application/events";
import { createDocumentTools } from "@/modules/agent/application/document-tools";
import { createDocumentVersionTools } from "@/modules/agent/application/document-version-tools";
import { createSourceContextTools } from "@/modules/agent/application/source-context-tools";
import { createImageInspectionTools } from "@/modules/agent/application/image-tools";
import { AgentImageGenerationService, createImageGenerationTools, imageReferenceResolver } from "@/modules/agent/application/image-generation";
import { createImageReplacementTools } from "@/modules/agent/application/image-replacement";
import { WorkingDocumentInspectionSession } from "@/modules/agent/application/document-inspection-session";
import { createImageGenerationProviderFromEnvironment } from "@/modules/generation/adapters/factory";
import { RemoteImageFetcher } from "@/modules/generation/application/generate-image-candidates";
import { SupabaseGeneratedAssetStore, SupabaseImageGenerationJobStore } from "@/modules/generation/infrastructure/supabase-generated-asset-store";
import { SupabaseStorageAdapter } from "@/modules/storage/adapters/supabase-storage";
import { createOpenAICompatibleAgentModelFromEnvironment } from "@/modules/agent/infrastructure/openai-compatible-model";
import { createImageVisionFromEnvironment } from "@/modules/agent/infrastructure/openai-compatible-vision";
import { SupabaseAgentLoopStore } from "@/modules/agent/infrastructure/supabase/loop-persistence";
import { SupabaseWorkingDocumentAccess } from "@/modules/agent/infrastructure/supabase/working-document-access";
import { SupabaseDocumentVersionAccess } from "@/modules/agent/infrastructure/supabase/document-version-access";
import { SupabaseSourceDocumentContext } from "@/modules/agent/infrastructure/supabase/source-context";
import { SupabaseAgentConversationContext } from "@/modules/agent/infrastructure/supabase/conversation-context";
import { OoxmlPreservationKernel } from "@/modules/documents";
import { logger, withLogContext } from "@/infrastructure/observability";
import { agentImageAttachmentSchema, type AgentImageAttachment } from "@/modules/agent/application/message-parts";
import { SupabaseImageAssetStore } from "@/modules/uploads/supabase-image-asset-store";
import { createClientDocumentTools } from "@/modules/agent/application/client-tools";

const schema = z.object({
  message: z.string().max(8_000),
  attachments: z.array(agentImageAttachmentSchema).max(4).default([]),
  permissionMode: z.enum(["default", "full"]).optional().default("default"),
  clientMessageId: z.uuid().optional(),
  interactionId: z.uuid().optional(),
}).refine((input) => input.message.trim().length > 0 || input.attachments.length > 0, "MESSAGE_REQUIRED");

const eventPayload = (event: string, data: unknown) => {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
};

async function createRunner(runId: string) {
  const { client, userId } = await requireSupabaseIdentity();
  const bootstrapStore = new SupabaseAgentLoopStore(client);
  const bootstrap = await bootstrapStore.loadBootstrap(runId);
  const owner = userId;
  const kernel = new OoxmlPreservationKernel();
  const taskId = bootstrap.taskId;
  const loopStore = new SupabaseAgentLoopStore(client, bootstrap);
  const working = new SupabaseWorkingDocumentAccess(client, taskId, runId, () => loopStore.getOwnedLockVersion(runId));
  const sources = new SupabaseSourceDocumentContext(client);
  const storage = new SupabaseStorageAdapter(client);
  const assets = new SupabaseGeneratedAssetStore(client);
  const resolver = imageReferenceResolver(kernel, working, sources, assets, storage, owner);
  const inspectionSession = new WorkingDocumentInspectionSession(kernel, working, ({ event, metadata }) => logger.info(event, { ...metadata, runId, taskId }));
  const tools = [
    ...createDocumentTools(kernel, working, ({ event, metadata }) => logger.info(event, { ...metadata, runId, taskId }), inspectionSession),
    ...createSourceContextTools(taskId, sources, kernel),
    ...createImageInspectionTools(taskId, kernel, working, sources, createImageVisionFromEnvironment(), assets, storage, owner, inspectionSession),
    ...createImageGenerationTools((context) => new AgentImageGenerationService(createImageGenerationProviderFromEnvironment(), new SupabaseImageGenerationJobStore(client), assets, storage, resolver, new RemoteImageFetcher(), owner, taskId, context.runId, context.callId, context.idempotencyKey)),
    ...createImageReplacementTools(kernel, working, assets, storage, owner, taskId, inspectionSession),
    ...createClientDocumentTools(),
    ...createDocumentVersionTools(new SupabaseDocumentVersionAccess(client, taskId)),
  ];
  const currentDocumentRevision = async () => {
    const workingDocument = await client.from("working_documents").select("current_version_id").eq("task_id", taskId).eq("owner_user_id", userId).maybeSingle();
    if (workingDocument.error || !workingDocument.data?.current_version_id) return undefined;
    const version = await client.from("document_versions").select("sha256").eq("id", workingDocument.data.current_version_id).eq("owner_user_id", userId).maybeSingle();
    if (version.error) throw new Error(version.error.message);
    return version.data?.sha256 as string | undefined;
  };
  return new AgentLoopRunner(createOpenAICompatibleAgentModelFromEnvironment(), loopStore, tools, 24, 48, 30_000, undefined, 30_000, ({ event, metadata }) => logger.info(event, metadata), new SupabaseAgentConversationContext(client, bootstrap.context), 120_000, currentDocumentRevision);
}

async function validateUploadedImages(runId: string, attachments: readonly AgentImageAttachment[]) {
  if (!attachments.length) return;
  const { client, userId } = await requireSupabaseIdentity();
  const run = await client.from("agent_runs").select("task_id").eq("id", runId).single();
  if (run.error || !run.data) throw new Error("RUN_NOT_FOUND");
  const assets = new SupabaseImageAssetStore(client);
  for (const image of attachments) {
    const asset = await assets.loadImage({ assetId: image.assetId, ownerUserId: userId, taskId: run.data.task_id as string });
    if (!asset || asset.kind !== "uploaded_image" || asset.mimeType !== image.mimeType) throw new Error("IMAGE_ASSET_INVALID");
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { runId } = await params;
  return withLogContext({ requestId }, async () => {
    const started = performance.now();
  try {
    const { client } = await requireSupabaseIdentity();
    const checkpoint = await new SupabaseAgentLoopStore(client).load(runId);
    if (!checkpoint) return NextResponse.json({ code: "LOOP_NOT_FOUND" }, { status: 404 });
    const url = new URL(request.url);
    const after = Number(url.searchParams.get("after") ?? "0");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "200"), 1), 500);
    const cursor = Number.isFinite(after) ? Math.max(0, after) : 0;
    const durable = await client.from("agent_run_events").select("sequence, event").eq("run_id", runId).gt("sequence", cursor).order("sequence", { ascending: true }).limit(limit + 1);
    if (durable.error) throw new Error(durable.error.message);
    const rows = durable.data ?? [];
    const hasMore = rows.length > limit;
    const returnedRows = rows.slice(0, limit);
    const events = returnedRows.map((row) => {
      const event = row.event && typeof row.event === "object" ? row.event as Record<string, unknown> : undefined;
      return event ? { ...event, sequence: row.sequence, runId } : undefined;
    }).filter((event) => Boolean(event) && isDurableAgentEvent(event));
    const nextSequence = returnedRows.at(-1)?.sequence ?? cursor;
    const response = NextResponse.json({ checkpoint: projectAgentLoopCheckpointForClient(checkpoint), events, nextSequence, hasMore });
    logger.info("agent.replay.completed", { runId, afterSequence: cursor, limit, durableEventCount: rows.length, returnedEventCount: events.length, nextSequence, hasMore, durationMs: performance.now() - started });
    logger.info("http.request.completed", { method: "GET", route: "/api/agent/runs/:runId/loop", status: response.status, durationMs: performance.now() - started, runId, afterSequence: cursor, durableEventCount: rows.length, returnedEventCount: events.length });
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    logger.error("http.request.failed", { method: "GET", route: "/api/agent/runs/:runId/loop", durationMs: performance.now() - started, runId, error });
    return NextResponse.json({ code: "AGENT_LOOP_LOAD_FAILED" }, { status: 500 });
  }
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { runId } = await params;
  return withLogContext({ requestId }, async () => {
    const started = performance.now();
  try {
    const input = schema.parse(await request.json());
    await validateUploadedImages(runId, input.attachments);
    const result = await (await createRunner(runId)).runWithPermission(runId, input.message, input.permissionMode as AgentPermissionMode, undefined, undefined, input.clientMessageId, input.interactionId, input.attachments);
    const response = NextResponse.json(projectAgentLoopResultForClient(result));
    logger.info("http.request.completed", { method: "POST", route: "/api/agent/runs/:runId/loop", status: response.status, durationMs: performance.now() - started, runId });
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    if (error instanceof Error && ["USER_INPUT_ALREADY_CLAIMED", "USER_INPUT_INTERACTION_MISMATCH", "USER_INPUT_RESOLUTION_MISMATCH"].includes(error.message)) return NextResponse.json({ code: error.message }, { status: 409 });
    logger.error("http.request.failed", { method: "POST", route: "/api/agent/runs/:runId/loop", durationMs: performance.now() - started, runId, error });
    return NextResponse.json({ code: "AGENT_LOOP_FAILED" }, { status: 500 });
  }
  });
}

/** POST with fetch streaming: emits public text deltas and audit-safe tool lifecycle events. */
export async function PUT(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const { runId } = await params;
  return withLogContext({ requestId }, async () => {
    const started = performance.now();
  try {
    const input = schema.parse(await request.json());
    await validateUploadedImages(runId, input.attachments);
    const runner = await createRunner(runId);
    const encoder = new TextEncoder();
    let eventCount = 0;
    let bytesSent = 0;
    let firstEventMs: number | undefined;
    let streamFailed = false;
    const stream = new ReadableStream({
      async start(controller) {
        let transportOpen = true;
        const close = () => { if (!transportOpen) return; transportOpen = false; try { controller.close(); } catch { /* detached consumer */ } };
        request.signal.addEventListener("abort", () => { transportOpen = false; }, { once: true });
        const heartbeat = setInterval(() => { if (transportOpen) { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { transportOpen = false; } } }, 12_000);
        const send = (event: string, data: unknown) => {
          if (!transportOpen) return;
          const payload = encoder.encode(eventPayload(event, data));
          firstEventMs ??= performance.now() - started;
          eventCount += 1;
          bytesSent += payload.byteLength;
          try { controller.enqueue(payload); } catch { transportOpen = false; }
        };
        try {
          const result = await runner.runWithPermission(runId, input.message, input.permissionMode as AgentPermissionMode, request.signal, (event) => send("event", event), input.clientMessageId, input.interactionId, input.attachments);
          send("result", projectAgentLoopResultForClient(result));
        } catch (error) {
          if (error instanceof Error && error.message === "TRANSPORT_INTERRUPTED") {
            logger.info("agent.transport.detached", { runId, eventCount, bytesSent });
          } else if (transportOpen) {
            streamFailed = true;
            send("error", { code: error instanceof Error ? error.message : "AGENT_LOOP_FAILED" });
          }
        } finally {
          clearInterval(heartbeat);
          logger.info(streamFailed || request.signal.aborted ? "agent.stream.failed" : "agent.stream.completed", { runId, firstEventMs, eventCount, bytesSent, aborted: request.signal.aborted, completed: !streamFailed && !request.signal.aborted });
          close();
        }
      },
    });
    logger.info("http.request.started", { method: "PUT", route: "/api/agent/runs/:runId/loop", runId, streaming: true });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "connection": "keep-alive", "x-accel-buffering": "no" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", issues: error.issues }, { status: 400 });
    if (error instanceof Error && error.message === "AUTHENTICATION_REQUIRED") return NextResponse.json({ code: error.message }, { status: 401 });
    if (error instanceof Error && ["USER_INPUT_ALREADY_CLAIMED", "USER_INPUT_INTERACTION_MISMATCH", "USER_INPUT_RESOLUTION_MISMATCH"].includes(error.message)) return NextResponse.json({ code: error.message }, { status: 409 });
    return NextResponse.json({ code: error instanceof Error ? error.message : "AGENT_LOOP_FAILED" }, { status: 500 });
  }
  });
}
