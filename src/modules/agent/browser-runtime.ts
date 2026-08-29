"use client";

import type { AgentRun } from "./domain/model";
import type { AgentPermissionMode } from "./application/loop";
import type { PublicAgentLoopResult } from "./application/public-runtime";
import { isAgentEvent, isDurableAgentEvent, type AgentEvent, type DurableAgentEvent } from "./application/events";
import type { AgentImageAttachment, AgentMessagePart } from "./application/message-parts";
import { SseParser } from "./browser/sse-parser";
import { createInFlightRequestCache } from "@/lib/in-flight-request";

type AgentResponse = { run: AgentRun };

const userFacingError = (code: string | undefined, fallback: string) => ({
  AGENT_LOOP_FAILED: "这次请求没有完成，请稍后重试；已保留执行记录。",
  AGENT_LOOP_RESUME_FAILED: "这次操作没有恢复成功，请重新确认当前请求。",
  TURN_NOT_ALLOWED: "当前对话正在等待处理，请先完成待处理的确认或回答。",
}[code ?? ""] ?? fallback);

type BrowserLog = { event: string; durationMs?: number; totalMs?: number; timeToHeadersMs?: number; firstEventMs?: number; firstSseEventMs?: number; firstModelDeltaMs?: number; chunkCount?: number; frameCount?: number; bytesReceived?: number; status?: number; route?: string; taskId?: string; lastEventId?: string; finalResultReceived?: boolean };
const browserLogQueue: BrowserLog[] = [];
let browserLogFlushTimer: ReturnType<typeof setTimeout> | undefined;
const flushBrowserLogs = () => {
  if (!browserLogQueue.length || process.env.NODE_ENV === "production") return;
  const events = browserLogQueue.splice(0, browserLogQueue.length);
  void fetch("/api/dev/logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }), keepalive: true }).catch(() => undefined);
};
const logBrowserEvent = (event: BrowserLog) => {
  if (process.env.NODE_ENV === "production") return;
  browserLogQueue.push(event);
  if (browserLogQueue.length >= 20) { if (browserLogFlushTimer) clearTimeout(browserLogFlushTimer); browserLogFlushTimer = undefined; flushBrowserLogs(); return; }
  if (!browserLogFlushTimer) browserLogFlushTimer = setTimeout(() => { browserLogFlushTimer = undefined; flushBrowserLogs(); }, 1000);
};

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    logBrowserEvent({ event: "client.fetch.failed", route: url.split("?")[0], durationMs: performance.now() - started });
    throw error;
  }
  logBrowserEvent({ event: response.ok ? "client.fetch.completed" : "client.fetch.failed", route: url.split("?")[0], status: response.status, durationMs: performance.now() - started });
  const body = await response.json().catch(() => ({})) as T & { code?: string; message?: string };
  if (!response.ok) {
    const userMessage = body.message ?? userFacingError(body.code, `请求未完成（HTTP ${response.status}）`);
    throw new Error(userMessage);
  }
  return body;
};

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function consumeAgentStream(
  response: Response,
  runId: string,
  onEvent: (event: AgentEvent) => void,
  startedAt: number,
  timeToHeadersMs: number,
) {
  if (!response.ok || !response.body) {
    logBrowserEvent({ event: "client.agent.loop_stream.failed", timeToHeadersMs, totalMs: performance.now() - startedAt, status: response.status, chunkCount: 0, frameCount: 0, bytesReceived: 0, finalResultReceived: false });
    const body = await response.json().catch(() => ({})) as { code?: string; message?: string };
    throw new Error(body.message ?? body.code ?? `HTTP_${response.status}`);
  }
  const reader = response.body.getReader();
  const parser = new SseParser();
  let finalResult: BrowserAgentLoopResult | undefined;
  let chunkCount = 0;
  let frameCount = 0;
  let bytesReceived = 0;
  let firstSseEventMs: number | undefined;
  let firstModelDeltaMs: number | undefined;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
    chunkCount += 1;
    bytesReceived += next.value.byteLength;
      for (const frame of parser.push(next.value)) {
        const event = frame.event;
        const raw = frame.data;
        if (!event) continue;
        frameCount += 1;
        firstSseEventMs ??= performance.now() - startedAt;
        if (!raw) continue;
        const data = JSON.parse(raw) as unknown;
        if (event === "event") {
          const normalized = isAgentEvent(data) && data.runId === runId ? data : undefined;
          if (normalized) {
            if (normalized.type === "model.delta") firstModelDeltaMs ??= performance.now() - startedAt;
            onEvent(normalized);
          }
        }
        if (event === "result" && typeof data === "object" && data !== null) finalResult = data as BrowserAgentLoopResult;
        if (event === "error") {
          const code = (data as { code?: string }).code;
          throw new Error(userFacingError(code, "这次请求没有完成，请稍后重试。"));
        }
      }
    }
    for (const frame of parser.flush()) {
      if (!frame.event || !frame.data) continue;
      frameCount += 1;
      const data = JSON.parse(frame.data) as unknown;
      if (frame.event === "event") {
        const normalized = isAgentEvent(data) && data.runId === runId ? data : undefined;
        if (normalized) {
          if (normalized.type === "model.delta") firstModelDeltaMs ??= performance.now() - startedAt;
          onEvent(normalized);
        }
      }
      if (frame.event === "result" && typeof data === "object" && data !== null) finalResult = data as BrowserAgentLoopResult;
      if (frame.event === "error") throw new Error(userFacingError((data as { code?: string }).code, "这次请求没有完成，请稍后重试。"));
    }
  } catch (error) {
    logBrowserEvent({ event: "client.agent.loop_stream.failed", timeToHeadersMs, firstSseEventMs, firstModelDeltaMs, totalMs: performance.now() - startedAt, chunkCount, frameCount, bytesReceived, finalResultReceived: Boolean(finalResult) });
    throw error;
  }
  if (!finalResult) {
    logBrowserEvent({ event: "client.agent.loop_stream.failed", timeToHeadersMs, firstSseEventMs, firstModelDeltaMs, totalMs: performance.now() - startedAt, chunkCount, frameCount, bytesReceived, finalResultReceived: false });
    throw new Error("AGENT_STREAM_INCOMPLETE");
  }
  logBrowserEvent({ event: "client.agent.loop_stream.completed", timeToHeadersMs, firstSseEventMs, firstModelDeltaMs, totalMs: performance.now() - startedAt, chunkCount, frameCount, bytesReceived, finalResultReceived: true });
  return { ...finalResult, events: finalResult.events.filter(isAgentEvent) };
}

const consumeAgentFetch = async (
  request: Promise<Response>,
  runId: string,
  onEvent: (event: AgentEvent) => void,
) => {
  const startedAt = performance.now();
  let responseReceived = false;
  try {
    const response = await request;
    responseReceived = true;
    return consumeAgentStream(response, runId, onEvent, startedAt, performance.now() - startedAt);
  } catch (error) {
    if (!responseReceived) {
      logBrowserEvent({ event: "client.agent.loop_stream.failed", totalMs: performance.now() - startedAt, finalResultReceived: false });
    }
    throw error;
  }
};

export const createBrowserAgentRun = async (taskId: string, goal: string, clientMessageId?: string, attachments: readonly AgentImageAttachment[] = []) => {
  const started = performance.now();
  logBrowserEvent({ event: "client.agent.run_create.started", taskId });
  try {
    const run = (await json<AgentResponse>("/api/agent/runs", post({ taskId, goal, attachments, ...(clientMessageId ? { clientMessageId } : {}) }))).run;
    logBrowserEvent({ event: "client.agent.run_create.completed", durationMs: performance.now() - started });
    return run;
  } catch (error) {
    logBrowserEvent({ event: "client.agent.run_create.failed", taskId, durationMs: performance.now() - started });
    throw error;
  }
};

export const loadBrowserAgentRun = async (runId: string) =>
  (await json<AgentResponse>(`/api/agent/runs/${runId}`)).run;

export type BrowserAgentTaskTimeline = {
  runs: ReadonlyArray<{
    id: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    checkpoint?: { status?: string };
    events: ReadonlyArray<DurableAgentEvent>;
  }>;
};

export const loadBrowserAgentTaskTimeline = async (taskId: string) =>
  (async () => {
    const timeline = await json<BrowserAgentTaskTimeline>(`/api/agent/runs?taskId=${encodeURIComponent(taskId)}`);
    return { ...timeline, runs: timeline.runs.map((run) => ({ ...run, events: normalizeReplayEvents(run.events) })) };
  })();

export type BrowserConversationMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  parts: ReadonlyArray<AgentMessagePart | { type?: string; text?: string; assetId?: unknown; mimeType?: unknown }>;
  run_id?: string | null;
  created_at: string;
  message_key: string;
  delivery_status?: "pending" | "sent" | "failed";
};

const conversationRequests = createInFlightRequestCache<string, { conversationId: string | null; messages: ReadonlyArray<BrowserConversationMessage>; nextCursor: string | null }>();

export const loadBrowserConversationMessages = (taskId: string, before?: string) => conversationRequests.load(`${taskId}:${before ?? "latest"}`, () =>
  json<{ conversationId: string | null; messages: ReadonlyArray<BrowserConversationMessage>; nextCursor: string | null }>(
    `/api/agent/messages?taskId=${encodeURIComponent(taskId)}&limit=30${before ? `&before=${encodeURIComponent(before)}` : ""}`,
  )
);

export type BrowserAgentEvent = AgentEvent;

export type BrowserAgentLoopResult = Omit<PublicAgentLoopResult, "events"> & {
  /** Server responses are normalized at the SSE boundary; JSON replay is
   * intentionally validated by the replay adapter before it reaches UI. */
  events: ReadonlyArray<AgentEvent>;
  nextSequence?: number;
  hasMore?: boolean;
};

export function normalizeReplayEvents(events: readonly unknown[]): DurableAgentEvent[] {
  return events.filter(isDurableAgentEvent);
}

export const runBrowserAgentLoop = async (runId: string, message: string, permissionMode: AgentPermissionMode = "default", interactionId?: string) =>
  json<BrowserAgentLoopResult>(`/api/agent/runs/${runId}/loop`, post({ message, permissionMode, ...(interactionId ? { interactionId } : {}) }));

/** Consume the Agent route's POST-capable SSE stream. */
export async function runBrowserAgentLoopStream(
  runId: string,
  message: string,
  permissionMode: AgentPermissionMode,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  clientMessageId?: string,
  interactionId?: string,
  attachments: readonly AgentImageAttachment[] = [],
) {
  return consumeAgentFetch(
    fetch(`/api/agent/runs/${runId}/loop`, { ...post({ message, permissionMode, attachments, ...(clientMessageId ? { clientMessageId } : {}), ...(interactionId ? { interactionId } : {}) }), method: "PUT", signal }),
    runId,
    onEvent,
  );
}

export const loadBrowserAgentLoop = async (runId: string, after = 0, limit = 500) =>
  (async () => {
    const result = await json<BrowserAgentLoopResult>(`/api/agent/runs/${runId}/loop?after=${after}&limit=${limit}`);
    return { ...result, events: normalizeReplayEvents(result.events) };
  })();

const recoveryBackoffMs = [300, 700, 1_500, 3_000, 5_000];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function recoverBrowserAgentLoop(
  runId: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
) {
  let after = 0;
  let latest: BrowserAgentLoopResult | undefined;
  for (let attempt = 0; attempt <= recoveryBackoffMs.length; attempt += 1) {
    const page = await loadBrowserAgentLoop(runId, after);
    latest = page;
    for (const event of page.events) onEvent(event);
    after = page.nextSequence ?? after;
    if (page.hasMore) { attempt -= 1; continue; }
    if (page.checkpoint.status !== "running") return page;
    try {
      const recovered = await consumeAgentFetch(fetch(`/api/agent/runs/${runId}/loop/recover`, { method: "PUT", signal }), runId, onEvent);
      return recovered;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt === recoveryBackoffMs.length) break;
      await wait(recoveryBackoffMs[attempt]);
      const refreshed = await loadBrowserAgentLoop(runId, after);
      latest = refreshed;
      if (refreshed.checkpoint.status !== "running") return refreshed;
    }
  }
  return latest ?? await loadBrowserAgentLoop(runId, after);
}

export const resumeBrowserAgentLoop = async (runId: string, approval: "approved" | "rejected", interactionId: string, callId: string) =>
  json<BrowserAgentLoopResult>(`/api/agent/runs/${runId}/loop/resume`, post({ approval, interactionId, callId }));

export const resumeBrowserAgentLoopStream = async (
  runId: string,
  approval: "approved" | "rejected",
  interactionId: string,
  callId: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
) => consumeAgentFetch(
  fetch(`/api/agent/runs/${runId}/loop/resume`, { ...post({ approval, interactionId, callId }), method: "PUT", signal }),
  runId,
  onEvent,
);

export const cancelBrowserAgentRun = async (runId: string) =>
  (await json<AgentResponse>(`/api/agent/runs/${runId}/cancel`, post({ commandId: crypto.randomUUID() }))).run;

export async function loadCurrentTaskDocument(taskId: string, fileName: string) {
  const metadata = await json<{
    version: { id: string; number: number; revision: string };
    downloadUrl: string;
  }>(`/api/tasks/${taskId}/document`);
  const downloadStarted = performance.now();
  const response = await fetch(metadata.downloadUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`DOCUMENT_DOWNLOAD_${response.status}`);
  const bytes = await response.arrayBuffer();
  logBrowserEvent({ event: "client.document.download.completed", durationMs: performance.now() - downloadStarted, bytesReceived: bytes.byteLength });
  return {
    ...metadata,
    file: new File([bytes], fileName, {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    bytes,
  };
}

export type BrowserDocumentVersion = {
  id: string;
  version_number: number;
  origin: "import" | "user" | "agent" | "restore";
  sha256: string;
  created_at: string;
};

export const loadBrowserDocumentVersions = async (taskId: string) =>
  json<{ currentVersionId: string; versions: BrowserDocumentVersion[] }>(`/api/tasks/${taskId}/versions`);

export const restoreBrowserDocumentVersion = async (taskId: string, versionId: string) =>
  json<{ version: { version_id: string; version_number: number; revision: string } }>(
    `/api/tasks/${taskId}/versions/${versionId}/restore`, post(),
  );

export const createBrowserDocumentExport = async (taskId: string) =>
  json<{ export: { id: string; versionId: string; number: number; revision: string }; downloadUrl: string }>(
    `/api/tasks/${taskId}/export`, post(),
  );

export type BrowserImageNode = { nodeId: string; contentType?: string; byteLength: number; path: string };
export const inspectBrowserTaskDocument = async (taskId: string) =>
  json<{ revision: string; counts: { paragraphs: number; tableCells: number; images: number }; images: BrowserImageNode[] }>(`/api/tasks/${taskId}/document/inspect`);
