import { z } from "zod";
import type { DocumentEnginePort } from "@/modules/documents/application/document-engine-port";
import type { AgentTool } from "./loop";
import type { SourceDocumentContextPort } from "./source-context-tools";
import type { ImageVisionPort } from "./vision";
import type { WorkingDocumentAccessPort } from "./document-tools";
import type { AgentImageAssetReader } from "./image-generation";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import type { WorkingDocumentInspectionSession } from "./document-inspection-session";

const schema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("working-document"), nodeId: z.string().trim().min(1).max(300) }),
  z.object({ source: z.literal("source-document"), sourceFileId: z.string().trim().min(1).max(200), nodeId: z.string().trim().min(1).max(300) }),
  z.object({ source: z.literal("asset"), assetId: z.string().uuid() }),
]).and(z.object({ instruction: z.string().trim().max(2_000).optional() }));

export function createImageInspectionTools(taskId: string, documents: DocumentEnginePort, working: WorkingDocumentAccessPort, sources: SourceDocumentContextPort, vision?: ImageVisionPort, assets?: AgentImageAssetReader, storage?: PrivateObjectStoragePort, ownerUserId?: string, session?: WorkingDocumentInspectionSession): readonly AgentTool[] {
  const readImage = documents.readImage;
  if (!vision || !readImage) return [];
  const inspectImage: AgentTool<typeof schema> = { name: "inspect_image", description: "Read and analyze one selected document image when the task depends on its visual content. Returns structured visual facts, never image bytes or URLs.", inputSchema: schema, async execute(input, context) {
    if (input.source === "asset") {
      if (!assets || !storage || !ownerUserId) throw new Error("IMAGE_ASSET_UNSUPPORTED");
      const asset = await assets.loadImage({ assetId: input.assetId, ownerUserId, taskId }); if (!asset) throw new Error("IMAGE_ASSET_NOT_FOUND");
      const bytes = await storage.get(asset.objectKey); const analysis = await vision.analyze({ bytes, mimeType: asset.mimeType, instruction: input.instruction, signal: context.signal });
      return { source: input.source, assetId: input.assetId, revision: asset.sha256, mimeType: asset.mimeType, byteLength: bytes.byteLength, analysis };
    }
    const loaded = input.source === "working-document" ? { bytes: (session ? await session.inspect() : await working.load()).bytes, sourceFileId: undefined } : await sources.load(taskId, input.sourceFileId);
    if (!loaded) throw new Error("SOURCE_DOCUMENT_NOT_FOUND");
    const image = await readImage.call(documents, loaded.bytes, input.nodeId);
    const analysis = await vision.analyze({ bytes: image.bytes, mimeType: image.contentType, instruction: input.instruction, signal: context.signal });
    return { source: input.source, ...(input.source === "source-document" ? { sourceFileId: input.sourceFileId } : {}), nodeId: input.nodeId, revision: image.revision, mimeType: image.contentType, byteLength: image.byteLength, analysis };
  } };
  return [inspectImage];
}
