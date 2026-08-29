import { MANUAL_EDIT_DOCX_MIME } from "../application/commit-manual-document-edit";

export class ManualEditRequestError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = "ManualEditRequestError";
  }
}

export async function saveBrowserManualDocumentEdit(input: { taskId: string; expectedRevision: string; file: Blob; fileName: string }) {
  const form = new FormData();
  form.set("file", new File([input.file], input.fileName, { type: MANUAL_EDIT_DOCX_MIME }));
  form.set("expectedRevision", input.expectedRevision);
  const response = await fetch(`/api/tasks/${input.taskId}/document/manual-edit`, { method: "POST", body: form });
  const body = await response.json().catch(() => ({})) as { code?: string; message?: string; versionId?: string; versionNumber?: number; revision?: string; noChange?: boolean };
  if (!response.ok) throw new ManualEditRequestError(body.code ?? "MANUAL_EDIT_FAILED", response.status, body.message ?? "手动编辑保存失败");
  if (typeof body.revision !== "string" || typeof body.noChange !== "boolean") throw new ManualEditRequestError("MANUAL_EDIT_RESPONSE_INVALID", 500, "手动编辑响应无效");
  return body as { versionId?: string; versionNumber?: number; revision: string; noChange: boolean };
}
