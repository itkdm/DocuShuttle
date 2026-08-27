"use client";

import type { TaskSummary, TaskWorkspace } from "./domain";

const json = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({})) as T & { code?: string };
  if (!response.ok) throw new Error(body.code ?? `HTTP_${response.status}`);
  return body;
};

export const listBrowserTasks = async () =>
  (await json<{ tasks: TaskSummary[] }>("/api/tasks")).tasks;

export const loadBrowserTaskWorkspace = async (taskId: string) =>
  (await json<{ workspace: TaskWorkspace }>(`/api/tasks/${taskId}`)).workspace;
