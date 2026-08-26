"use client";

import type { AgentRun } from "./domain/model";
import type { AgentPermissionMode } from "./application/loop";

type AgentResponse = { run: AgentRun };
type AdvanceResponse = { kind: string; run: AgentRun };

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { code?: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? body.code ?? `HTTP_${response.status}`);
  return body;
};

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const createBrowserAgentRun = async (taskId: string, goal: string) =>
  (await json<AgentResponse>("/api/agent/runs", post({ taskId, goal }))).run;

export const loadBrowserAgentRun = async (runId: string) =>
  (await json<AgentResponse>(`/api/agent/runs/${runId}`)).run;

export const advanceBrowserAgentRun = async (runId: string) =>
  (await json<AdvanceResponse>(`/api/agent/runs/${runId}/advance`, post())).run;

export type BrowserAgentLoopResult = {
  checkpoint: {
    status: "running" | "awaiting_user" | "completed" | "failed";
    finalText?: string;
    iterations: number;
    pendingApproval?: { callId: string; name: string; input: unknown };
    messages: ReadonlyArray<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
    permissionMode?: AgentPermissionMode;
  };
  events: ReadonlyArray<{ type: string; text?: string; name?: string; error?: string; [key: string]: unknown }>;
};

export const runBrowserAgentLoop = async (runId: string, message: string, permissionMode: AgentPermissionMode = "default") =>
  json<BrowserAgentLoopResult>(`/api/agent/runs/${runId}/loop`, post({ message, permissionMode }));

export const loadBrowserAgentLoop = async (runId: string) =>
  json<BrowserAgentLoopResult>(`/api/agent/runs/${runId}/loop`);

export const resumeBrowserAgentLoop = async (runId: string, approval: "approved" | "rejected") =>
  json<BrowserAgentLoopResult>(`/api/agent/runs/${runId}/loop/resume`, post({ approval }));

export const decideBrowserAgentRun = async (runId: string, choice: "approved" | "rejected") =>
  (await json<AgentResponse>(`/api/agent/runs/${runId}/decision`, post({
    commandId: crypto.randomUUID(),
    decisionId: crypto.randomUUID(),
    choice,
  }))).run;

export const reviewBrowserAgentRun = async (
  runId: string,
  choice: "approved" | "rejected",
  reviewedRevision: string,
) => (await json<AgentResponse>(`/api/agent/runs/${runId}/review`, post({
  commandId: crypto.randomUUID(),
  decisionId: crypto.randomUUID(),
  choice,
  reviewedRevision,
}))).run;

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
