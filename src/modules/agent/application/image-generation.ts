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
export type ImageGenerationJob = { id: string; ownerUserId: string; taskId: string; runId: string; callId: string; idempotencyKey: string; requestHash: string; provider: string; model?: string; status: "created" | "submitting" | "submitted" | "completed" | "failed" | "ambiguous"; providerTaskId?: string; candidateAssetId: string; safeRequest: unknown; result?: unknown; errorCode?: string; errorMessage?: string; createdAt?: string; updatedAt?: string };
export interface ImageGenerationJobStore {
  createOrGet(input: Omit<ImageGenerationJob, "status" | "createdAt" | "updatedAt">): Promise<ImageGenerationJob>;
  get(idempotencyKey: string): Promise<ImageGenerationJob | undefined>;
  claimForSubmission(id: string): Promise<boolean>;
  update(id: string, patch: Partial<Pick<ImageGenerationJob, "status" | "providerTaskId" | "result" | "errorCode" | "errorMessage">>): Promise<ImageGenerationJob>;
}
export interface GeneratedAgentAssetStore {
  ensureGenerated(input: { id: string; ownerUserId: string; taskId: string; objectKey: string; mimeType: string; sha256: string; provider: string; providerRequestId?: string; prompt: string }): Promise<{ id: string }>;
  load(input: { assetId: string; ownerUserId: string; taskId: string }): Promise<{ objectKey: string; mimeType: string; sha256: string; provider?: string } | null>;
}

const referenceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("working-document"), nodeId: z.string().trim().min(1).max(300) }),
  z.object({ source: z.literal("source-document"), sourceFileId: z.string().trim().min(1).max(200), nodeId: z.string().trim().min(1).max(300) }),
  z.object({ source: z.literal("asset"), assetId: z.string().uuid() }),
]);
export const generateImageSchema = z.object({ prompt: z.string().trim().min(1).max(6_000), purpose: z.enum(["create", "similar", "edit"]), references: z.array(referenceSchema).max(4).optional(), size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).optional(), quality: z.enum(["standard", "high"]).default("standard") });
const hash = async (value: unknown) => { const bytes = new TextEncoder().encode(JSON.stringify(value)); const digest = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join(""); };
const sha256 = async (bytes: Uint8Array) => { const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer); return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join(""); };
const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);

export const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
};

export const stableJson = (value: unknown) => JSON.stringify(canonicalizeJson(value));

export class AgentImageGenerationService {
  constructor(private readonly provider: ImageGenerationPort, private readonly jobs: ImageGenerationJobStore, private readonly assets: GeneratedAgentAssetStore, private readonly storage: PrivateObjectStoragePort, private readonly resolver: AgentImageReferenceResolver, private readonly fetcher: { fetch(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> }, private readonly ownerUserId: string, private readonly taskId: string, private readonly runId: string, private readonly callId: string, private readonly idempotencyKey: string) {}
  async execute(input: z.infer<typeof generateImageSchema>, signal?: AbortSignal): Promise<unknown> {
    const logicalRequest = { prompt: input.prompt, purpose: input.purpose, ...(input.size ? { size: input.size } : {}), quality: input.quality, references: (input.references ?? []).map((reference) => ({ source: reference.source, ...(reference.source === "working-document" ? { nodeId: reference.nodeId } : {}), ...(reference.source === "source-document" ? { sourceFileId: reference.sourceFileId, nodeId: reference.nodeId } : {}), ...(reference.source === "asset" ? { assetId: reference.assetId } : {}) })) };
    const requestHash = await hash(logicalRequest);
    const existing = await this.jobs.get(this.idempotencyKey);
    if (existing && existing.requestHash !== requestHash) throw new Error("IMAGE_GENERATION_IDEMPOTENCY_CONFLICT");
    if (existing?.status === "completed") return existing.result;
    const refs = existing?.status === "submitted" || existing?.status === "ambiguous" || existing?.status === "failed" || existing?.status === "submitting" ? [] : await Promise.all((input.references ?? []).map((ref) => this.resolver.resolve(this.taskId, ref)));
    const safeRequest = refs.length || !existing ? { prompt: input.prompt, purpose: input.purpose, ...(input.size ? { size: input.size } : {}), quality: input.quality, references: refs.map(({ safeRef }) => safeRef) } : existing.safeRequest;
    const job = existing ?? await this.jobs.createOrGet({ id: crypto.randomUUID(), idempotencyKey: this.idempotencyKey, requestHash, provider: this.provider.provider ?? "unknown", candidateAssetId: crypto.randomUUID(), safeRequest, ownerUserId: this.ownerUserId, taskId: this.taskId, runId: this.runId, callId: this.callId });
    if (job.requestHash !== requestHash) throw new Error("IMAGE_GENERATION_IDEMPOTENCY_CONFLICT");
    const existingAsset = await this.assets.load({ assetId: job.candidateAssetId, ownerUserId: this.ownerUserId, taskId: this.taskId });
    if (existingAsset) {
      if (existingAsset.provider && existingAsset.provider !== (this.provider.provider ?? "unknown")) throw new Error("ASSET_IDEMPOTENCY_CONFLICT");
      const replay = { assetId: job.candidateAssetId, mimeType: existingAsset.mimeType, sha256: existingAsset.sha256, purpose: input.purpose, referenceCount: logicalRequest.references.length };
      await this.jobs.update(job.id, { status: "completed", result: replay });
      return replay;
    }
    if (job.status === "submitting" && !job.providerTaskId) throw new Error("IMAGE_GENERATION_SUBMISSION_AMBIGUOUS");
    if (job.status === "ambiguous") throw new Error("IMAGE_GENERATION_SUBMISSION_AMBIGUOUS");
    if (job.status === "failed") throw new Error(job.errorMessage ?? "IMAGE_GENERATION_FAILED");
    if (job.status === "created") {
      const referenceBytes = refs.map(({ input: reference }) => reference.bytes.byteLength);
      if (referenceBytes.some((size) => size === 0)) throw new Error("IMAGE_REFERENCE_INVALID");
      if (referenceBytes.some((size) => size > 20 * 1024 * 1024)) throw new Error("IMAGE_REFERENCE_TOO_LARGE");
      if (referenceBytes.reduce((total, size) => total + size, 0) > 40 * 1024 * 1024) throw new Error("IMAGE_REFERENCES_TOO_LARGE");
      if (stableJson(safeRequest) !== stableJson(job.safeRequest)) throw new Error("IMAGE_REFERENCE_CHANGED_BEFORE_SUBMISSION");
    }
    let completed = job;
    if (job.status === "created") {
      if (!this.provider.capabilities?.textToImage) throw new Error("IMAGE_GENERATION_UNSUPPORTED");
      if (refs.length && !this.provider.capabilities.referenceImages) throw new Error("IMAGE_REFERENCE_UNSUPPORTED");
      if (refs.length > 4 || refs.length > (this.provider.capabilities.maxReferenceImages ?? 0)) throw new Error("IMAGE_REFERENCE_LIMIT_EXCEEDED");
      const claimed = await this.jobs.claimForSubmission(job.id);
      if (!claimed) { const current = await this.jobs.get(this.idempotencyKey); if (!current) throw new Error("IMAGE_GENERATION_JOB_NOT_FOUND"); return this.execute(input, signal); }
      let submitted: Awaited<ReturnType<NonNullable<ImageGenerationPort["submit"]>>>;
      try {
        const response = await this.provider.submit?.({ prompt: input.prompt, size: input.size, quality: input.quality, ...(refs.length ? { referenceImages: refs.map(({ input: value }) => value) } : {}) }, signal);
        if (!response) throw new Error("IMAGE_GENERATION_PROVIDER_LIFECYCLE_UNAVAILABLE");
        submitted = response;
      } catch (error) {
        const ambiguous = error instanceof Error && (/IMAGE_GENERATION_SUBMISSION_AMBIGUOUS|Abort|timeout|fetch|network|ECONN/i.test(error.message) || ("retryable" in error && (error as { retryable?: boolean }).retryable));
        await this.jobs.update(job.id, { status: ambiguous ? "ambiguous" : "failed", errorCode: ambiguous ? "IMAGE_GENERATION_SUBMISSION_AMBIGUOUS" : "IMAGE_GENERATION_FAILED", errorMessage: error instanceof Error ? error.message : "Image submission failed" });
        throw error;
      }
        if (submitted.status === "completed") return this.persistCompletedImage(job, input, logicalRequest.references.length, submitted.images?.[0], signal);
      if (!submitted.providerTaskId) {
        await this.jobs.update(job.id, { status: "ambiguous", errorCode: "IMAGE_GENERATION_SUBMISSION_AMBIGUOUS", errorMessage: "Provider submission returned no task id" });
        throw new Error("IMAGE_GENERATION_SUBMISSION_AMBIGUOUS");
      }
      completed = await this.jobs.update(job.id, { status: "submitted", providerTaskId: submitted.providerTaskId });
    }
    if (!completed.providerTaskId || !this.provider.poll) throw new Error("IMAGE_GENERATION_PROVIDER_LIFECYCLE_UNAVAILABLE");
    let polled;
    for (;;) {
      try { polled = await this.provider.poll(completed.providerTaskId, signal); break; }
      catch (error) { if (signal?.aborted) throw signal.reason ?? error; if (!(error && typeof error === "object" && "retryable" in error && (error as { retryable?: boolean }).retryable)) { await this.jobs.update(job.id, { status: "failed", errorCode: "IMAGE_GENERATION_POLL_FAILED", errorMessage: error instanceof Error ? error.message : "Image polling failed" }); throw error; } await abortableDelay(2_000, signal); }
    }
    while (polled.status === "pending") {
      await abortableDelay(2_000, signal);
      try { polled = await this.provider.poll(completed.providerTaskId, signal); } catch (error) { if (signal?.aborted) throw signal.reason ?? error; if (!(error && typeof error === "object" && "retryable" in error && (error as { retryable?: boolean }).retryable)) { await this.jobs.update(job.id, { status: "failed", errorCode: "IMAGE_GENERATION_POLL_FAILED", errorMessage: error instanceof Error ? error.message : "Image polling failed" }); throw error; } }
    }
    if (polled.status === "failed") { await this.jobs.update(job.id, { status: "failed", errorCode: "IMAGE_GENERATION_FAILED", errorMessage: polled.error }); throw new Error(polled.error ?? "IMAGE_GENERATION_FAILED"); }
    const image = polled.images?.[0]; if (!image) throw new Error("IMAGE_GENERATION_EMPTY_RESULT");
    const binary = image.bytes ? { bytes: image.bytes, mimeType: image.mimeType } : image.remoteUrl ? await this.fetcher.fetch(image.remoteUrl, signal) : undefined; if (!binary) throw new Error("IMAGE_GENERATION_EMPTY_RESULT");
    if (!allowed.has(binary.mimeType) || binary.bytes.byteLength > 20 * 1024 * 1024) throw new Error("IMAGE_GENERATION_TYPE_UNSUPPORTED");
    return this.persistCompletedImage(job, input, logicalRequest.references.length, { ...image, bytes: binary.bytes, mimeType: binary.mimeType }, signal);
  }
  private async persistCompletedImage(job: ImageGenerationJob, input: z.infer<typeof generateImageSchema>, referenceCount: number, image: { bytes?: Uint8Array; mimeType: string; remoteUrl?: string; providerRequestId?: string } | undefined, signal?: AbortSignal) {
    if (!image) throw new Error("IMAGE_GENERATION_EMPTY_RESULT");
    const binary = image.bytes ? { bytes: image.bytes, mimeType: image.mimeType } : image.remoteUrl ? await this.fetcher.fetch(image.remoteUrl, signal) : undefined; if (!binary) throw new Error("IMAGE_GENERATION_EMPTY_RESULT");
    if (binary.bytes.byteLength === 0) throw new Error("IMAGE_GENERATION_EMPTY_RESULT");
    if (!allowed.has(binary.mimeType) || binary.bytes.byteLength > 20 * 1024 * 1024) throw new Error("IMAGE_GENERATION_TYPE_UNSUPPORTED");
    const digest = await sha256(binary.bytes); const extension = binary.mimeType === "image/jpeg" ? "jpg" : binary.mimeType.split("/")[1]; const objectKey = `users/${this.ownerUserId}/tasks/${this.taskId}/assets/${job.candidateAssetId}.${extension}`;
    if (this.storage.ensureObject) await this.storage.ensureObject(objectKey, binary.bytes, binary.mimeType); else await this.storage.put(objectKey, binary.bytes, binary.mimeType);
    await this.assets.ensureGenerated({ id: job.candidateAssetId, ownerUserId: this.ownerUserId, taskId: this.taskId, objectKey, mimeType: binary.mimeType, sha256: digest, provider: this.provider.provider ?? "unknown", providerRequestId: image.providerRequestId, prompt: input.prompt });
    const result = { assetId: job.candidateAssetId, mimeType: binary.mimeType, sha256: digest, purpose: input.purpose, referenceCount };
    await this.jobs.update(job.id, { status: "completed", result }); return result;
  }
}

const abortableDelay = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { let settled = false; const cleanup = () => signal?.removeEventListener("abort", onAbort); const onAbort = () => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); }; const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); resolve(); }, milliseconds); signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort(); });

export function createImageGenerationTools(createService: (context: { runId: string; callId: string; idempotencyKey: string }) => AgentImageGenerationService): readonly AgentTool[] { return [{ name: "generate_image", description: "Generate a private image asset. Use references for similar or edit requests; this never modifies the Word document.", inputSchema: generateImageSchema, async execute(input, context) { return createService(context).execute(generateImageSchema.parse(input), context.signal); } }]; }

export const imageReferenceResolver = (documents: DocumentEnginePort, working: WorkingDocumentAccessPort, sources: SourceDocumentContextPort, assets: GeneratedAgentAssetStore, storage: PrivateObjectStoragePort, ownerUserId: string): AgentImageReferenceResolver => ({ async resolve(taskId, reference) { if (reference.source === "asset") { const asset = await assets.load({ assetId: reference.assetId, ownerUserId, taskId }); if (!asset) throw new Error("IMAGE_ASSET_NOT_FOUND"); return { input: { bytes: await storage.get(asset.objectKey), mimeType: asset.mimeType as ImageReferenceInput["mimeType"] }, safeRef: { source: "asset", assetId: reference.assetId, fingerprint: asset.sha256 } }; } const document = reference.source === "working-document" ? await working.load() : await sources.load(taskId, reference.sourceFileId); if (!document) throw new Error("SOURCE_DOCUMENT_NOT_FOUND"); if (!documents.readImage) throw new Error("IMAGE_REFERENCE_UNSUPPORTED"); const image = await documents.readImage(document.bytes, reference.nodeId); if (!image || !allowed.has(image.contentType)) throw new Error("IMAGE_REFERENCE_NOT_FOUND"); return { input: { bytes: image.bytes, mimeType: image.contentType as ImageReferenceInput["mimeType"] }, safeRef: { source: reference.source, ...(reference.source === "source-document" ? { sourceFileId: reference.sourceFileId } : {}), nodeId: reference.nodeId, revision: image.revision, fingerprint: image.fingerprint } }; } });
