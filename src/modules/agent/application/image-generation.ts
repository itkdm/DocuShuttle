import { z } from "zod";
import type { AgentTool } from "./loop";
import type { DocumentEnginePort } from "@/modules/documents/application/document-engine-port";
import type { WorkingDocumentAccessPort } from "./document-tools";
import type { SourceDocumentContextPort } from "./source-context-tools";
import type { ImageGenerationPort, ImageReferenceInput } from "@/modules/generation/ports";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";

export type AgentImageReference =
  | { source: "working-document"; nodeId: string }
  | { source: "source-document"; sourceFileId: string; nodeId: string }
  | { source: "asset"; assetId: string };

export type ResolvedAgentImageReference = { input: ImageReferenceInput; safeRef: Record<string, string | undefined> };
export interface AgentImageReferenceResolver { resolve(taskId: string, reference: AgentImageReference): Promise<ResolvedAgentImageReference>; }
export type ImageGenerationJob = { id: string; idempotencyKey: string; requestHash: string; provider: string; model?: string; status: "created" | "submitting" | "submitted" | "completed" | "failed" | "ambiguous"; providerTaskId?: string; candidateAssetId: string; safeRequest: unknown; result?: unknown; errorCode?: string; errorMessage?: string };
export interface ImageGenerationJobStore {
  create(input: Omit<ImageGenerationJob, "status"> & { ownerUserId: string; taskId: string; runId: string; callId: string }): Promise<ImageGenerationJob>;
  get(idempotencyKey: string): Promise<ImageGenerationJob | undefined>;
  update(id: string, patch: Partial<Pick<ImageGenerationJob, "status" | "providerTaskId" | "result" | "errorCode" | "errorMessage">>): Promise<ImageGenerationJob>;
}
export interface GeneratedAgentAssetStore {
  ensureGenerated(input: { id: string; ownerUserId: string; taskId: string; objectKey: string; mimeType: string; sha256: string; provider: string; providerRequestId?: string; prompt: string }): Promise<{ id: string }>;
  load(input: { assetId: string; ownerUserId: string; taskId: string }): Promise<{ objectKey: string; mimeType: string; sha256: string } | null>;
}

const referenceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("working-document"), nodeId: z.string().trim().min(1).max(300) }),
  z.object({ source: z.literal("source-document"), sourceFileId: z.string().trim().min(1).max(200), nodeId: z.string().trim().min(1).max(300) }),
  z.object({ source: z.literal("asset"), assetId: z.string().uuid() }),
]);
export const generateImageSchema = z.object({ prompt: z.string().trim().min(1).max(6_000), purpose: z.enum(["create", "similar", "edit"]), references: z.array(referenceSchema).max(4).optional(), size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).optional(), quality: z.enum(["standard", "high"]).default("standard") });
const hash = async (value: unknown) => { const bytes = new TextEncoder().encode(JSON.stringify(value)); const digest = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join(""); };
const sha256 = async (bytes: Uint8Array) => hash(Array.from(bytes));
const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);

export class AgentImageGenerationService {
  constructor(private readonly provider: ImageGenerationPort, private readonly jobs: ImageGenerationJobStore, private readonly assets: GeneratedAgentAssetStore, private readonly storage: PrivateObjectStoragePort, private readonly resolver: AgentImageReferenceResolver, private readonly fetcher: { fetch(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> }, private readonly ownerUserId: string, private readonly taskId: string, private readonly runId: string, private readonly callId: string, private readonly idempotencyKey: string) {}
  async execute(input: z.infer<typeof generateImageSchema>, signal?: AbortSignal) {
    const refs = await Promise.all((input.references ?? []).map((ref) => this.resolver.resolve(this.taskId, ref)));
    const safeRequest = { prompt: input.prompt, purpose: input.purpose, ...(input.size ? { size: input.size } : {}), quality: input.quality, references: refs.map(({ safeRef }) => safeRef) };
    const requestHash = await hash(safeRequest);
    const existing = await this.jobs.get(this.idempotencyKey);
    if (existing && existing.requestHash !== requestHash) throw new Error("IMAGE_GENERATION_IDEMPOTENCY_CONFLICT");
    const job = existing ?? await this.jobs.create({ id: crypto.randomUUID(), idempotencyKey: this.idempotencyKey, requestHash, provider: this.provider.provider ?? "unknown", candidateAssetId: crypto.randomUUID(), safeRequest, ownerUserId: this.ownerUserId, taskId: this.taskId, runId: this.runId, callId: this.callId });
    if (job.status === "completed") return job.result;
    if (job.status === "submitting" && !job.providerTaskId) throw new Error("IMAGE_GENERATION_SUBMISSION_AMBIGUOUS");
    const existingAsset = await this.assets.load({ assetId: job.candidateAssetId, ownerUserId: this.ownerUserId, taskId: this.taskId });
    if (existingAsset) {
      const replay = { assetId: job.candidateAssetId, mimeType: existingAsset.mimeType, sha256: existingAsset.sha256, purpose: input.purpose, referenceCount: refs.length };
      await this.jobs.update(job.id, { status: "completed", result: replay });
      return replay;
    }
    let completed = job;
    if (job.status === "created") {
      if (!this.provider.capabilities?.textToImage) throw new Error("IMAGE_GENERATION_UNSUPPORTED");
      if (refs.length && !this.provider.capabilities.referenceImages) throw new Error("IMAGE_REFERENCE_UNSUPPORTED");
      if (refs.length > 4 || refs.length > (this.provider.capabilities.maxReferenceImages ?? 0)) throw new Error("IMAGE_REFERENCE_LIMIT_EXCEEDED");
      completed = await this.jobs.update(job.id, { status: "submitting" });
      const submitted = await this.provider.submit?.({ prompt: input.prompt, size: input.size, quality: input.quality, ...(refs.length ? { referenceImages: refs.map(({ input: value }) => value) } : {}) }, signal);
      if (!submitted?.providerTaskId) throw new Error("IMAGE_GENERATION_SUBMISSION_AMBIGUOUS");
      completed = await this.jobs.update(job.id, { status: "submitted", providerTaskId: submitted.providerTaskId });
    }
    if (!completed.providerTaskId || !this.provider.poll) throw new Error("IMAGE_GENERATION_PROVIDER_LIFECYCLE_UNAVAILABLE");
    let polled = await this.provider.poll(completed.providerTaskId, signal);
    for (let attempt = 1; polled.status === "pending" && attempt < 60; attempt += 1) {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 2_000); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); }, { once: true }); });
      polled = await this.provider.poll(completed.providerTaskId, signal);
    }
    if (polled.status === "pending") return { status: "submitted", providerTaskId: completed.providerTaskId };
    if (polled.status === "failed") { await this.jobs.update(job.id, { status: "failed", errorCode: "IMAGE_GENERATION_FAILED", errorMessage: polled.error }); throw new Error(polled.error ?? "IMAGE_GENERATION_FAILED"); }
    const image = polled.images?.[0]; if (!image) throw new Error("IMAGE_GENERATION_EMPTY_RESULT");
    const binary = image.bytes ? { bytes: image.bytes, mimeType: image.mimeType } : image.remoteUrl ? await this.fetcher.fetch(image.remoteUrl, signal) : undefined; if (!binary) throw new Error("IMAGE_GENERATION_EMPTY_RESULT");
    if (!allowed.has(binary.mimeType) || binary.bytes.byteLength > 20 * 1024 * 1024) throw new Error("IMAGE_GENERATION_TYPE_UNSUPPORTED");
    const digest = await sha256(binary.bytes); const extension = binary.mimeType === "image/jpeg" ? "jpg" : binary.mimeType.split("/")[1]; const objectKey = `users/${this.ownerUserId}/tasks/${this.taskId}/assets/${job.candidateAssetId}.${extension}`;
    if (this.storage.ensureObject) await this.storage.ensureObject(objectKey, binary.bytes, binary.mimeType); else await this.storage.put(objectKey, binary.bytes, binary.mimeType);
    await this.assets.ensureGenerated({ id: job.candidateAssetId, ownerUserId: this.ownerUserId, taskId: this.taskId, objectKey, mimeType: binary.mimeType, sha256: digest, provider: this.provider.provider ?? "unknown", providerRequestId: image.providerRequestId, prompt: input.prompt });
    const result = { assetId: job.candidateAssetId, mimeType: binary.mimeType, sha256: digest, purpose: input.purpose, referenceCount: refs.length };
    await this.jobs.update(job.id, { status: "completed", result }); return result;
  }
}

export function createImageGenerationTools(createService: (context: { runId: string; callId: string; idempotencyKey: string }) => AgentImageGenerationService): readonly AgentTool[] { return [{ name: "generate_image", description: "Generate a private image asset. Use references for similar or edit requests; this never modifies the Word document.", inputSchema: generateImageSchema, async execute(input, context) { return createService(context).execute(generateImageSchema.parse(input), context.signal); } }]; }

export const imageReferenceResolver = (documents: DocumentEnginePort, working: WorkingDocumentAccessPort, sources: SourceDocumentContextPort, assets: GeneratedAgentAssetStore, storage: PrivateObjectStoragePort, ownerUserId: string): AgentImageReferenceResolver => ({ async resolve(taskId, reference) { if (reference.source === "asset") { const asset = await assets.load({ assetId: reference.assetId, ownerUserId, taskId }); if (!asset) throw new Error("IMAGE_ASSET_NOT_FOUND"); return { input: { bytes: await storage.get(asset.objectKey), mimeType: asset.mimeType as ImageReferenceInput["mimeType"] }, safeRef: { source: "asset", assetId: reference.assetId, fingerprint: asset.sha256 } }; } const document = reference.source === "working-document" ? await working.load() : await sources.load(taskId, reference.sourceFileId); if (!document) throw new Error("SOURCE_DOCUMENT_NOT_FOUND"); if (!documents.readImage) throw new Error("IMAGE_REFERENCE_UNSUPPORTED"); const image = await documents.readImage(document.bytes, reference.nodeId); if (!image || !allowed.has(image.contentType)) throw new Error("IMAGE_REFERENCE_NOT_FOUND"); return { input: { bytes: image.bytes, mimeType: image.contentType as ImageReferenceInput["mimeType"] }, safeRef: { source: reference.source, ...(reference.source === "source-document" ? { sourceFileId: reference.sourceFileId } : {}), nodeId: reference.nodeId, revision: image.revision, fingerprint: image.fingerprint } }; } });
