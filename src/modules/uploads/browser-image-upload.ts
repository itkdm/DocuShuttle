import type { AgentImageAttachment } from "@/modules/agent/application/message-parts";

export async function uploadBrowserImage(taskId: string, file: File): Promise<AgentImageAttachment> {
  const form = new FormData();
  form.set("taskId", taskId);
  form.set("file", file);
  const response = await fetch("/api/uploads/image", { method: "POST", body: form });
  const body = await response.json().catch(() => ({})) as { assetId?: unknown; mimeType?: unknown; sha256?: unknown; code?: string };
  if (!response.ok || typeof body.assetId !== "string" || typeof body.mimeType !== "string") {
    throw new Error(body.code ?? "IMAGE_UPLOAD_FAILED");
  }
  return { assetId: body.assetId, mimeType: body.mimeType as AgentImageAttachment["mimeType"] };
}
