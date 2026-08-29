import { describe, expect, it, vi } from "vitest";
import { AgentImageGenerationService } from "../application/image-generation";
import type { GeneratedAgentAssetStore, ImageGenerationJob } from "../application/image-generation";
import type { ImageGenerationPort } from "@/modules/generation/ports";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";

const bytes = new Uint8Array([1, 2, 3]);
const storage = () => ({ put: vi.fn(), get: vi.fn(), remove: vi.fn(), createSignedUpload: vi.fn(), createSignedDownload: vi.fn(), ensureObject: vi.fn() }) as unknown as PrivateObjectStoragePort;
const jobStore = (options?: { failCompletedUpdate?: boolean }) => { const jobs = new Map<string, ImageGenerationJob>(); let failCompletedUpdate = options?.failCompletedUpdate ?? false; return { jobs, async createOrGet(input: Omit<ImageGenerationJob, "status" | "createdAt" | "updatedAt">) { const existing = jobs.get(input.idempotencyKey); if (existing) return existing; const job: ImageGenerationJob = { ...input, status: "created" }; jobs.set(input.idempotencyKey, job); return job; }, async get(key: string) { return jobs.get(key); }, async claimForSubmission(id: string) { const job = [...jobs.values()].find((value) => value.id === id); if (!job || job.status !== "created") return false; job.status = "submitting"; return true; }, async update(id: string, patch: Partial<Pick<ImageGenerationJob, "status" | "providerTaskId" | "result" | "errorCode" | "errorMessage">>) { const job = [...jobs.values()].find((value) => value.id === id); if (!job) throw new Error("missing job"); if (failCompletedUpdate && patch.status === "completed") { failCompletedUpdate = false; throw new Error("response lost"); } Object.assign(job, patch); return job; } }; };

describe("Agent image generation", () => {
  it("persists a private candidate once and replays the exact completed job", async () => {
    const jobs = jobStore(); const assets: GeneratedAgentAssetStore = { ensureGenerated: vi.fn(async ({ id }) => ({ id })), load: vi.fn(async () => null) }; const objectStorage = storage();
    const provider: ImageGenerationPort = { provider: "fake", capabilities: { textToImage: true, referenceImages: true, asyncJobs: true, maxReferenceImages: 4 }, submit: vi.fn(async () => ({ status: "submitted" as const, providerTaskId: "task-1" })), poll: vi.fn(async () => ({ status: "completed" as const, providerTaskId: "task-1", images: [{ mimeType: "image/png", bytes }] })), generate: vi.fn() };
    const make = () => new AgentImageGenerationService(provider, jobs, assets, objectStorage, { resolve: vi.fn() }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key");
    const first = await make().execute({ prompt: "duck", purpose: "create", quality: "standard" }); const second = await make().execute({ prompt: "duck", purpose: "create", quality: "standard" });
    expect(first).toEqual(second); expect(first).toMatchObject({ sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" }); expect(provider.submit).toHaveBeenCalledOnce(); expect(provider.poll).toHaveBeenCalledOnce(); expect(assets.ensureGenerated).toHaveBeenCalledOnce(); expect(JSON.stringify(first)).not.toContain("base64");
  });

  it("rejects a changed request under the same idempotency key", async () => {
    const jobs = jobStore(); const provider: ImageGenerationPort = { provider: "fake", capabilities: { textToImage: true, referenceImages: false, asyncJobs: true, maxReferenceImages: 0 }, submit: vi.fn(), poll: vi.fn(), generate: vi.fn() };
    const service = (prompt: string) => new AgentImageGenerationService(provider, jobs, { ensureGenerated: vi.fn(), load: vi.fn(async () => null) }, storage(), { resolve: vi.fn() }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key").execute({ prompt, purpose: "create", quality: "standard" });
    await expect(service("one")).rejects.toThrow();
    await expect(service("two")).rejects.toThrow("IMAGE_GENERATION_IDEMPOTENCY_CONFLICT");
  });

  it("does not submit an ambiguous job again", async () => {
    const jobs = jobStore(); const job = await jobs.createOrGet({ id: "job", ownerUserId: "owner", taskId: "task", runId: "run", callId: "call", idempotencyKey: "key", requestHash: "6e5398aeecabb7e36f46b28ebd2f026868067ef91ffd9f6e8ac5798db06d92a4", provider: "fake", candidateAssetId: "asset", safeRequest: {} }); await jobs.update(job.id, { status: "submitting" });
    const provider: ImageGenerationPort = { provider: "fake", capabilities: { textToImage: true, referenceImages: false, asyncJobs: true, maxReferenceImages: 0 }, submit: vi.fn(), poll: vi.fn(), generate: vi.fn() };
    const service = new AgentImageGenerationService(provider, jobs, { ensureGenerated: vi.fn(), load: vi.fn(async () => null) }, storage(), { resolve: vi.fn() }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key");
    await expect(service.execute({ prompt: "x", purpose: "create", quality: "standard" })).rejects.toThrow("IMAGE_GENERATION_SUBMISSION_AMBIGUOUS"); expect(provider.submit).not.toHaveBeenCalled(); expect(provider.poll).not.toHaveBeenCalled();
  });

  it("recovers a submitted job without submitting again", async () => {
    const jobs = jobStore();
    const created = await jobs.createOrGet({ id: "job", ownerUserId: "owner", taskId: "task", runId: "run", callId: "call", idempotencyKey: "key", requestHash: "6e5398aeecabb7e36f46b28ebd2f026868067ef91ffd9f6e8ac5798db06d92a4", provider: "fake", candidateAssetId: "asset", safeRequest: {} });
    await jobs.update(created.id, { status: "submitted", providerTaskId: "provider-task" });
    const provider: ImageGenerationPort = { provider: "fake", capabilities: { textToImage: true, referenceImages: false, asyncJobs: true, maxReferenceImages: 0 }, submit: vi.fn(), poll: vi.fn(async () => ({ status: "completed" as const, providerTaskId: "provider-task", images: [{ mimeType: "image/png", bytes }] })), generate: vi.fn() };
    const assets: GeneratedAgentAssetStore = { ensureGenerated: vi.fn(async ({ id }) => ({ id })), load: vi.fn(async () => null) };
    const result = await new AgentImageGenerationService(provider, jobs, assets, storage(), { resolve: vi.fn() }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key").execute({ prompt: "x", purpose: "create", quality: "standard" });
    expect(result).toMatchObject({ assetId: "asset" });
    expect(provider.submit).not.toHaveBeenCalled();
    expect(provider.poll).toHaveBeenCalledWith("provider-task", undefined);
  });

  it("replays a completed job without resolving mutable references", async () => {
    const jobs = jobStore();
    await jobs.createOrGet({ id: "job", ownerUserId: "owner", taskId: "task", runId: "run", callId: "call", idempotencyKey: "key", requestHash: "6e5398aeecabb7e36f46b28ebd2f026868067ef91ffd9f6e8ac5798db06d92a4", provider: "fake", candidateAssetId: "asset", safeRequest: {}, });
    await jobs.update("job", { status: "completed", result: { assetId: "asset" } });
    const resolver = vi.fn(async () => { throw new Error("MUST_NOT_RESOLVE"); });
    const provider: ImageGenerationPort = { provider: "fake", submit: vi.fn(), poll: vi.fn(), generate: vi.fn() };
    const result = await new AgentImageGenerationService(provider, jobs, { ensureGenerated: vi.fn(), load: vi.fn() }, storage(), { resolve: resolver }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key").execute({ prompt: "x", purpose: "create", quality: "standard" });
    expect(result).toEqual({ assetId: "asset" });
    expect(resolver).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
    expect(provider.poll).not.toHaveBeenCalled();
  });

  it("rejects a changed working reference before the first submission", async () => {
    const jobs = jobStore();
    const provider: ImageGenerationPort = { provider: "fake", capabilities: { textToImage: true, referenceImages: true, asyncJobs: true, maxReferenceImages: 4 }, submit: vi.fn(), poll: vi.fn(), generate: vi.fn() };
    const resolver = vi.fn(async () => ({ input: { bytes, mimeType: "image/png" as const }, safeRef: { source: "working-document", nodeId: "node", revision: "B", fingerprint: "B" } }));
    const logicalRequest = { prompt: "x", purpose: "similar", quality: "standard", references: [{ source: "working-document", nodeId: "node" }] };
    const requestHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(logicalRequest)))), (value) => value.toString(16).padStart(2, "0")).join("");
    await jobs.createOrGet({ id: "job", ownerUserId: "owner", taskId: "task", runId: "run", callId: "call", idempotencyKey: "key", requestHash, provider: "fake", candidateAssetId: "asset", safeRequest: { ...logicalRequest, references: [{ ...logicalRequest.references[0], revision: "A", fingerprint: "A" }] } });
    const service = new AgentImageGenerationService(provider, jobs, { ensureGenerated: vi.fn(), load: vi.fn(async () => null) }, storage(), { resolve: resolver }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key");
    await expect(service.execute({ prompt: "x", purpose: "similar", quality: "standard", references: [{ source: "working-document", nodeId: "node" }] })).rejects.toThrow("IMAGE_REFERENCE_CHANGED_BEFORE_SUBMISSION");
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("persists a synchronous provider completion without polling", async () => {
    const jobs = jobStore();
    const provider: ImageGenerationPort = { provider: "fake", capabilities: { textToImage: true, referenceImages: false, asyncJobs: false, maxReferenceImages: 0 }, submit: vi.fn(async () => ({ status: "completed" as const, images: [{ mimeType: "image/png", bytes }] })), poll: vi.fn(), generate: vi.fn() };
    const assets: GeneratedAgentAssetStore = { ensureGenerated: vi.fn(async ({ id }) => ({ id })), load: vi.fn(async () => null) };
    const result = await new AgentImageGenerationService(provider, jobs, assets, storage(), { resolve: vi.fn() }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key").execute({ prompt: "x", purpose: "create", quality: "standard" });
    expect(result).toMatchObject({ sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" });
    expect(provider.poll).not.toHaveBeenCalled();
  });

  it("reconciles a durable asset after the completed-job update response is lost", async () => {
    const jobs = jobStore({ failCompletedUpdate: true });
    const assetRows = new Map<string, { objectKey: string; mimeType: string; sha256: string; provider: string }>();
    const assets: GeneratedAgentAssetStore = { ensureGenerated: vi.fn(async (input) => { assetRows.set(input.id, { objectKey: input.objectKey, mimeType: input.mimeType, sha256: input.sha256, provider: input.provider }); return { id: input.id }; }), load: vi.fn(async ({ assetId }) => assetRows.get(assetId) ?? null) };
    const provider: ImageGenerationPort = { provider: "fake", capabilities: { textToImage: true, referenceImages: false, asyncJobs: false, maxReferenceImages: 0 }, submit: vi.fn(async () => ({ status: "completed" as const, images: [{ mimeType: "image/png", bytes }] })), generate: vi.fn() };
    const service = new AgentImageGenerationService(provider, jobs, assets, storage(), { resolve: vi.fn() }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key");
    await expect(service.execute({ prompt: "x", purpose: "create", quality: "standard" })).rejects.toThrow("response lost");
    const result = await service.execute({ prompt: "x", purpose: "create", quality: "standard" });
    expect(result).toMatchObject({ assetId: expect.any(String) });
    expect(provider.submit).toHaveBeenCalledOnce();
    expect(assets.ensureGenerated).toHaveBeenCalledOnce();
  });
});
