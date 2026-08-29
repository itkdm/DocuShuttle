import { z } from "zod";
import type { DocumentEnginePort } from "@/modules/documents/application/document-engine-port";
import type { AgentTool } from "./loop";
import type { SourceDocumentContextPort } from "./source-context-tools";
import type { ImageVisionPort } from "./vision";
import type { WorkingDocumentAccessPort } from "./document-tools";

const schema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("working-document"), nodeId: z.string().trim().min(1).max(300) }),
  z.object({ source: z.literal("source-document"), sourceFileId: z.string().trim().min(1).max(200), nodeId: z.string().trim().min(1).max(300) }),
]).and(z.object({ instruction: z.string().trim().max(2_000).optional() }));

export function createImageInspectionTools(taskId: string, documents: DocumentEnginePort, working: WorkingDocumentAccessPort, sources: SourceDocumentContextPort, vision?: ImageVisionPort): readonly AgentTool[] {
  const readImage = documents.readImage;
  if (!vision || !readImage) return [];
  const inspectImage: AgentTool<typeof schema> = { name: "inspect_image", description: "Read and analyze one selected document image when the task depends on its visual content. Returns structured visual facts, never image bytes or URLs.", inputSchema: schema, async execute(input) {
    const loaded = input.source === "working-document" ? { bytes: (await working.load()).bytes, sourceFileId: undefined } : await sources.load(taskId, input.sourceFileId);
    if (!loaded) throw new Error("SOURCE_DOCUMENT_NOT_FOUND");
    const image = await readImage.call(documents, loaded.bytes, input.nodeId);
    const analysis = await vision.analyze({ bytes: image.bytes, mimeType: image.contentType, instruction: input.instruction });
    return { source: input.source, ...(input.source === "source-document" ? { sourceFileId: input.sourceFileId } : {}), nodeId: input.nodeId, revision: image.revision, mimeType: image.contentType, byteLength: image.byteLength, analysis };
  } };
  return [inspectImage];
}
