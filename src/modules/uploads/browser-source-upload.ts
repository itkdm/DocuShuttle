"use client";

import { ensureAnonymousSession } from "@/infrastructure/supabase/browser";
import type { SourceRole } from "@/modules/tasks/domain";

export type PersistedSourceFile = {
  sourceFileId: string;
  role: SourceRole;
  originalName?: string;
  workingDocumentId?: string;
  versionId?: string;
};

type ApiErrorBody = { code?: string };

const requestJson = async <T>(url: string, init: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!response.ok) throw new Error(body.code ?? `HTTP_${response.status}`);
  return body;
};

const sha256 = async (bytes: ArrayBuffer) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice(0));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const proxyUpload = async (input: { file: File; taskId: string; role: SourceRole; originalName: string }) => {
  const form = new FormData();
  form.set("taskId", input.taskId); form.set("role", input.role); form.set("originalName", input.originalName); form.set("file", input.file);
  return requestJson<PersistedSourceFile>("/api/uploads/source/proxy", { method: "POST", body: form });
};

export async function persistSourceFile(input: {
  file: File;
  bytes: ArrayBuffer;
  role: SourceRole;
  taskId?: string;
}) {
  await ensureAnonymousSession();
  let taskId = input.taskId;
  if (!taskId) {
    const created = await requestJson<{ task: { id: string } }>("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: input.file.name.replace(/\.docx$/i, ""), goal: "理解并完成这份 Word 文档" }),
    });
    taskId = created.task.id;
  }

  const checksum = await sha256(input.bytes);
  const signed = await requestJson<{ upload: { url: string; objectKey: string; headers: Record<string, string> } }>("/api/uploads/source/sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, role: input.role, originalName: input.file.name, byteLength: input.file.size }),
  });
  const uploadAbort = new AbortController();
  const timer = window.setTimeout(() => uploadAbort.abort(), 15_000);
  let directUploadFailed = false;
  try {
    const uploaded = await fetch(signed.upload.url, { method: "PUT", headers: signed.upload.headers, body: input.bytes.slice(0), signal: uploadAbort.signal });
    directUploadFailed = !uploaded.ok;
  } catch { directUploadFailed = true; } finally { window.clearTimeout(timer); }
  if (directUploadFailed) return { taskId, ...(await proxyUpload({ file: input.file, taskId, role: input.role, originalName: input.file.name })) };

  const completed = await requestJson<PersistedSourceFile>("/api/uploads/source/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId,
      role: input.role,
      originalName: input.file.name,
      objectKey: signed.upload.objectKey,
      expectedBytes: input.file.size,
      expectedSha256: checksum,
    }),
  });
  return { taskId, ...completed, role: input.role };
}
