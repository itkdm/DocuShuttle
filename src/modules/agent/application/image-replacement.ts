import { z } from "zod";
import type { AgentTool } from "./loop";
import type { DocumentEnginePort } from "@/modules/documents/application/document-engine-port";
import type { WorkingDocumentAccessPort } from "./document-tools";
import type { GeneratedAgentAssetStore } from "./image-generation";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import { blockingPackageErrors } from "@/modules/documents/infrastructure/ooxml/diagnostic-policy";

const schema = z.object({ targetNodeId: z.string().trim().min(1).max(300), assetId: z.string().uuid(), expectedRevision: z.string().trim().min(1).max(300) });
export const createImageReplacementTools = (documents: DocumentEnginePort, working: WorkingDocumentAccessPort, assets: GeneratedAgentAssetStore, storage: PrivateObjectStoragePort, ownerUserId: string, taskId: string): readonly AgentTool[] => [{ name: "replace_document_image", description: "Replace one existing Word image with a generated private asset. This creates a new immutable document version and requires approval.", requiresApproval: true, inputSchema: schema, async execute(rawInput, context) {
  const input = schema.parse(rawInput);
  const current = await working.load(); if (current.revision !== input.expectedRevision) throw new Error("DOCUMENT_REVISION_CONFLICT");
  const inspection = await documents.inspect(current.bytes); const node = inspection.manifest.nodes.find((candidate) => candidate.nodeId === input.targetNodeId && candidate.kind === "image");
  const image = inspection.images.find((candidate) => candidate.address.nodeId === input.targetNodeId); if (!node || !image) throw new Error("DOCUMENT_REGION_NOT_FOUND");
  const asset = await assets.load({ assetId: input.assetId, ownerUserId, taskId }); if (!asset) throw new Error("IMAGE_ASSET_NOT_FOUND");
  if (asset.mimeType !== image.contentType) throw new Error("IMAGE_CONTENT_TYPE_CHANGE_UNSUPPORTED");
  const bytes = await storage.get(asset.objectKey); const operation = { kind: "replace-image" as const, address: image.address, expectedHash: image.address.fingerprint, bytes, contentType: asset.mimeType };
  const mutation = await documents.mutate(current.bytes, { expectedRevision: input.expectedRevision, operations: [operation] }); const validated = await documents.validate(mutation.bytes); if (blockingPackageErrors(validated.diagnostics).length) throw new Error("DERIVED_DOCUMENT_VALIDATION_FAILED");
  const output = { targetNodeId: input.targetNodeId, assetId: input.assetId, previousRevision: input.expectedRevision, revision: mutation.manifest.revision, changedEntries: mutation.changedEntries, validation: mutation.validation?.valid };
  const committed = await working.commit({ idempotencyKey: context.idempotencyKey, expectedRevision: input.expectedRevision, bytes: mutation.bytes, revision: mutation.manifest.revision, changedEntries: mutation.changedEntries, effectReceipt: { idempotencyKey: context.idempotencyKey, callId: context.callId, toolName: "replace_document_image", output, completedAt: new Date().toISOString(), stepId: context.callId, effect: "apply" } });
  return { ...output, revision: committed.revision };
} }];
