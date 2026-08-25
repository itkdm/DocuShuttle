"use client";

import { ensureAnonymousSession } from "@/infrastructure/supabase/browser";
import type { SourceRole } from "@/modules/tasks/domain";

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

export const productionPersistenceConfigured = () => Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);

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
  const uploaded = await fetch(signed.upload.url, { method: "PUT", headers: signed.upload.headers, body: input.bytes.slice(0) });
  if (!uploaded.ok) throw new Error(`STORAGE_UPLOAD_${uploaded.status}`);

  const completed = await requestJson<{ sourceFileId: string; workingDocumentId?: string; versionId?: string }>("/api/uploads/source/complete", {
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
  return { taskId, ...completed };
}
