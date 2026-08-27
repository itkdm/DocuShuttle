"use client";

import type { AgentRun } from "./domain/model";
import type { AgentPermissionMode } from "./application/loop";
import { SseParser } from "./browser/sse-parser";

type AgentResponse = { run: AgentRun };

const userFacingError = (code: string | undefined, fallback: string) => ({
  IMAGE_GENERATION_FAILED: "图片候选暂时生成失败，请稍后重试；如果持续失败，请检查图片服务配置。",
  IMAGE_APPLY_FAILED: "图片候选应用失败，请刷新文档后重试。",
  AGENT_LOOP_FAILED: "这次请求没有完成，请稍后重试；已保留执行记录。",
  AGENT_LOOP_RESUME_FAILED: "这次操作没有恢复成功，请重新确认当前请求。",
  TURN_NOT_ALLOWED: "当前对话正在等待处理，请先完成待处理的确认或回答。",
}[code ?? ""] ?? fallback);

type BrowserLog = { event: string; durationMs?: number; status?: number; route?: string; firstEventMs?: number; chunkCount?: number; frameCount?: number; bytesReceived?: number; lastEventId?: string; finalResultReceived?: boolean };
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
  onEvent: (event: BrowserAgentLoopResult["events"][number]) => void,
) {
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({})) as { code?: string; message?: string };
    throw new Error(body.message ?? body.code ?? `HTTP_${response.status}`);
  }
  const reader = response.body.getReader();
  const parser = new SseParser();
  let finalResult: BrowserAgentLoopResult | undefined;
  let chunkCount = 0;
  let frameCount = 0;
  let bytesReceived = 0;
  let firstEventMs: number | undefined;
  let lastSequence = 0;
  const started = performance.now();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
    chunkCount += 1;
    bytesReceived += next.value.byteLength;
    firstEventMs ??= performance.now() - started;
      for (const frame of parser.push(next.value)) {
        const event = frame.event;
        const raw = frame.data;
        if (!event) continue;
        frameCount += 1;
        if (!raw) continue;
        const data = JSON.parse(raw) as BrowserAgentLoopResult | BrowserAgentLoopResult["events"][number] | { code?: string };
        if (event === "event") {
          const normalized = { ...data, eventId: String((data as { eventId?: unknown }).eventId ?? crypto.randomUUID()), runId, timestamp: String((data as { timestamp?: unknown }).timestamp ?? new Date().toISOString()) } as BrowserAgentEvent;
          const sequence = typeof normalized.sequence === "number" ? normalized.sequence : undefined;
          if (sequence === undefined || sequence > lastSequence) {
            if (sequence !== undefined) lastSequence = sequence;
            onEvent(normalized);
          }
        }
        if (event === "result") finalResult = data as BrowserAgentLoopResult;
        if (event === "error") {
          const code = (data as { code?: string }).code;
          throw new Error(userFacingError(code, "这次请求没有完成，请稍后重试。"));
        }
      }
    }
    for (const frame of parser.flush()) {
      if (!frame.event || !frame.data) continue;
      frameCount += 1;
      const data = JSON.parse(frame.data) as BrowserAgentLoopResult | BrowserAgentLoopResult["events"][number] | { code?: string };
      if (frame.event === "event") {
        const normalized = { ...data, eventId: String((data as { eventId?: unknown }).eventId ?? crypto.randomUUID()), runId, timestamp: String((data as { timestamp?: unknown }).timestamp ?? new Date().toISOString()) } as BrowserAgentEvent;
        const sequence = typeof normalized.sequence === "number" ? normalized.sequence : undefined;
        if (sequence === undefined || sequence > lastSequence) { if (sequence !== undefined) lastSequence = sequence; onEvent(normalized); }
      }
      if (frame.event === "result") finalResult = data as BrowserAgentLoopResult;
      if (frame.event === "error") throw new Error(userFacingError((data as { code?: string }).code, "这次请求没有完成，请稍后重试。"));
    }
  } catch (error) {
    logBrowserEvent({ event: "client.sse.failed", firstEventMs, chunkCount, frameCount, bytesReceived, finalResultReceived: Boolean(finalResult) });
    throw error;
  }
  logBrowserEvent({ event: finalResult ? "client.sse.completed" : "client.sse.failed", firstEventMs, chunkCount, frameCount, bytesReceived, finalResultReceived: Boolean(finalResult) });
  if (!finalResult) throw new Error("AGENT_STREAM_INCOMPLETE");
  return finalResult;
}

export const createBrowserAgentRun = async (taskId: string, goal: string, clientMessageId?: string) =>
  (await json<AgentResponse>("/api/agent/runs", post({ taskId, goal, ...(clientMessageId ? { clientMessageId } : {}) }))).run;

export const loadBrowserAgentRun = async (runId: string) =>
  (await json<AgentResponse>(`/api/agent/runs/${runId}`)).run;

export type BrowserAgentTaskTimeline = {
  runs: ReadonlyArray<{
    id: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    checkpoint?: { status?: string };
    events: ReadonlyArray<BrowserAgentLoopResult["events"][number]>;
  }>;
};

export const loadBrowserAgentTaskTimeline = async (taskId: string) =>
  (async () => {
    const timeline = await json<BrowserAgentTaskTimeline>(`/api/agent/runs?taskId=${encodeURIComponent(taskId)}`);
    return { ...timeline, runs: timeline.runs.map((run) => ({ ...run, events: normalizeReplayEvents(run.events, run.id) })) };
  })();

export type BrowserConversationMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  parts: ReadonlyArray<{ type?: string; text?: string; [key: string]: unknown }>;
  run_id?: string | null;
  created_at: string;
  message_key: string;
  delivery_status?: "pending" | "sent" | "failed";
};

export const loadBrowserConversationMessages = async (taskId: string, before?: string) =>
  json<{ conversationId: string | null; messages: ReadonlyArray<BrowserConversationMessage>; nextCursor: string | null }>(
    `/api/agent/messages?taskId=${encodeURIComponent(taskId)}&limit=30${before ? `&before=${encodeURIComponent(before)}` : ""}`,
  );

export type BrowserAgentEvent = {
  eventId: string;
  runId: string;
  timestamp: string;
  sequence?: number;
} & ({ type: "turn.started"; text: string; clientMessageId?: string }
  | { type: "model.started"; text: string }
  | { type: "model.completed"; durationMs?: number }
  | { type: "model.delta"; text: string; channel?: "commentary" | "reasoning_summary" | "final" }
  | { type: "assistant.message"; text: string }
  | { type: "tool.started"; callId: string; name: string; input: unknown }
  | { type: "tool.completed"; callId: string; name: string; output: unknown }
  | { type: "tool.failed"; callId: string; name: string; error: string; durationMs?: number }
  | { type: "approval.required"; callId: string; name: string; input: unknown }
  | { type: "approval.resolved"; callId: string; name: string; decision: "approved" | "rejected" }
  | { type: "completed"; text: string }
  | { type: "turn.failed"; error: string }
  | { type: "turn.cancelled"; text: string });

export type BrowserAgentLoopResult = {
  checkpoint: {
    status: "running" | "awaiting_user" | "completed" | "failed" | "cancelled";
    finalText?: string;
    iterations: number;
    pendingApproval?: { callId: string; name: string; input: unknown };
    pendingUserQuestion?: { text: string };
    messages: ReadonlyArray<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
    permissionMode?: AgentPermissionMode;
  };
  /** Server responses are normalized at the SSE boundary; JSON replay is
   * intentionally validated by the replay adapter before it reaches UI. */
  events: ReadonlyArray<{ type: string; text?: string; name?: string; error?: string; eventId?: string; sequence?: number; timestamp?: string; runId?: string; clientMessageId?: string; [key: string]: unknown }>;
};

const replayEventTypes = new Set(["turn.started", "model.started", "model.completed", "model.delta", "assistant.message", "tool.started", "tool.completed", "tool.failed", "approval.required", "approval.resolved", "completed", "turn.failed", "turn.cancelled"]);
export function normalizeReplayEvents(events: BrowserAgentLoopResult["events"], runId: string): BrowserAgentEvent[] {
  return events.flatMap((event) => {
    if (!replayEventTypes.has(event.type) || typeof event.eventId !== "string" || typeof event.timestamp !== "string") return [];
    return [{ ...event, eventId: event.eventId, runId, timestamp: event.timestamp } as BrowserAgentEvent];
  });
}

export const runBrowserAgentLoop = async (runId: string, message: string, permissionMode: AgentPermissionMode = "default") =>
  json<BrowserAgentLoopResult>(`/api/agent/runs/${runId}/loop`, post({ message, permissionMode }));

/** Consume the Agent route's POST-capable SSE stream. */
export async function runBrowserAgentLoopStream(
  runId: string,
  message: string,
  permissionMode: AgentPermissionMode,
  onEvent: (event: BrowserAgentLoopResult["events"][number]) => void,
  signal?: AbortSignal,
  clientMessageId?: string,
) {
  return consumeAgentStream(
    await fetch(`/api/agent/runs/${runId}/loop`, { ...post({ message, permissionMode, ...(clientMessageId ? { clientMessageId } : {}) }), method: "PUT", signal }),
    runId,
    onEvent,
  );
}

export const loadBrowserAgentLoop = async (runId: string, after?: number) =>
  (async () => {
    const result = await json<BrowserAgentLoopResult & { nextSequence?: number }>(`/api/agent/runs/${runId}/loop${after ? `?after=${after}` : ""}`);
    return { ...result, events: normalizeReplayEvents(result.events, runId) };
  })();

export const resumeBrowserAgentLoop = async (runId: string, approval: "approved" | "rejected") =>
  json<BrowserAgentLoopResult>(`/api/agent/runs/${runId}/loop/resume`, post({ approval }));

export const resumeBrowserAgentLoopStream = async (
  runId: string,
  approval: "approved" | "rejected",
  onEvent: (event: BrowserAgentLoopResult["events"][number]) => void,
  signal?: AbortSignal,
) => consumeAgentStream(
  await fetch(`/api/agent/runs/${runId}/loop/resume`, { ...post({ approval }), method: "PUT", signal }),
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
  const response = await fetch(metadata.downloadUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`DOCUMENT_DOWNLOAD_${response.status}`);
  const bytes = await response.arrayBuffer();
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

export type BrowserImageCandidate = {
  id: string;
  taskId: string;
  targetNodeId?: string;
  mimeType: string;
  downloadUrl: string;
  provider: string;
  providerRequestId?: string;
};

export const generateBrowserImageCandidates = async (input: {
  taskId: string;
  prompt: string;
  targetNodeId?: string;
  count?: number;
}) => json<{ candidates: BrowserImageCandidate[] }>(`/api/tasks/${input.taskId}/images`, post(input));

export const applyBrowserImageCandidate = async (input: {
  taskId: string;
  assetId: string;
  targetNodeId: string;
  expectedRevision: string;
}) => json<{ versionId: string; versionNumber: number; revision: string }>(
  `/api/tasks/${input.taskId}/images/${input.assetId}/apply`, post(input),
);

export type BrowserImageNode = { nodeId: string; contentType?: string; byteLength: number; path: string };
export const inspectBrowserTaskDocument = async (taskId: string) =>
  json<{ revision: string; counts: { paragraphs: number; tableCells: number; images: number }; images: BrowserImageNode[] }>(`/api/tasks/${taskId}/document/inspect`);
