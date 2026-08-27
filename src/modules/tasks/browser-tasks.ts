"use client";

import type { TaskSummary, TaskWorkspace } from "./domain";

export type TaskPage = { tasks: TaskSummary[]; nextOffset: number | null; hasMore: boolean };

const json = async <T>(url: string): Promise<T> => {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    void fetch("/api/dev/logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ event: "client.fetch.failed", route: url.split("?")[0], durationMs: performance.now() - started }] }), keepalive: true }).catch(() => undefined);
    throw error;
  }
  void fetch("/api/dev/logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ event: response.ok ? "client.fetch.completed" : "client.fetch.failed", route: url.split("?")[0], status: response.status, durationMs: performance.now() - started }] }), keepalive: true }).catch(() => undefined);
  const body = await response.json().catch(() => ({})) as T & { code?: string };
  if (!response.ok) throw new Error(body.code ?? `HTTP_${response.status}`);
  return body;
};

export const listBrowserTasks = async (offset = 0, limit = 20) =>
  json<TaskPage>(`/api/tasks?offset=${offset}&limit=${limit}`);

export const loadBrowserTaskWorkspace = async (taskId: string) =>
  (await json<{ workspace: TaskWorkspace }>(`/api/tasks/${taskId}`)).workspace;
