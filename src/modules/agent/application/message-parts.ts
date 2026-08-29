import { z } from "zod";

export const agentImageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
export type AgentImageMimeType = z.infer<typeof agentImageMimeTypeSchema>;
export type AgentImageAttachment = { assetId: string; mimeType: AgentImageMimeType };
export type AgentMessagePart =
  | { type: "text"; text: string }
  | ({ type: "image" } & AgentImageAttachment);

export const agentImageAttachmentSchema = z.object({ assetId: z.uuid(), mimeType: agentImageMimeTypeSchema }).strict();
export const agentMessagePartsSchema = z.array(z.union([
  z.object({ type: z.literal("text"), text: z.string().max(8_000) }).strict(),
  z.object({ type: z.literal("image"), assetId: z.uuid(), mimeType: agentImageMimeTypeSchema }).strict(),
])).max(5);

export function normalizeAgentMessageParts(value: unknown): AgentMessagePart[] {
  const parsed = agentMessagePartsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function imagePartsFromMessageParts(value: unknown): AgentImageAttachment[] {
  return normalizeAgentMessageParts(value).filter((part): part is AgentImageAttachment & { type: "image" } => part.type === "image");
}

export function textFromAgentMessageParts(value: unknown): string {
  return normalizeAgentMessageParts(value).filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
}

export function describeAgentImages(images: readonly AgentImageAttachment[]): string {
  if (!images.length) return "";
  return `\n\n用户附加了 ${images.length} 张图片。需要视觉理解时，请调用 inspect_image，并使用对应的 assetId。\n${images.map((image) => `- assetId: ${image.assetId}`).join("\n")}`;
}
