import { describe, expect, it, vi } from "vitest";
import { AgentImageGenerationService } from "../application/image-generation";
import type { GeneratedAgentAssetStore, ImageGenerationJob } from "../application/image-generation";
import type { ImageGenerationPort } from "@/modules/generation/ports";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";

const bytes = new Uint8Array([1, 2, 3]);
const storage = () => ({ put: vi.fn(), get: vi.fn(), remove: vi.fn(), createSignedUpload: vi.fn(), createSignedDownload: vi.fn(), ensureObject: vi.fn() }) as unknown as PrivateObjectStoragePort;
const jobStore = () => { const jobs = new Map<string, ImageGenerationJob>(); return { jobs, async create(input: Omit<ImageGenerationJob, "status"> & { ownerUserId: string; taskId: string; runId: string; callId: string }) { const job: ImageGenerationJob = { ...input, status: "created" }; jobs.set(input.idempotencyKey, job); return job; }, async get(key: string) { return jobs.get(key); }, async update(id: string, patch: Partial<Pick<ImageGenerationJob, "status" | "providerTaskId" | "result" | "errorCode" | "errorMessage">>) { const job = [...jobs.values()].find((value) => value.id === id); if (!job) throw new Error("missing job"); Object.assign(job, patch); return job; } }; };

describe("Agent image generation", () => {
  it("persists a private candidate once and replays the exact completed job", async () => {
    const jobs = jobStore(); const assets: GeneratedAgentAssetStore = { ensureGenerated: vi.fn(async ({ id }) => ({ id })), load: vi.fn(async () => null) }; const objectStorage = storage();
    const provider: ImageGenerationPort = { provider: "fake", capabilities: { textToImage: true, referenceImages: true, asyncJobs: true, maxReferenceImages: 4 }, submit: vi.fn(async () => ({ status: "submitted" as const, providerTaskId: "task-1" })), poll: vi.fn(async () => ({ status: "completed" as const, providerTaskId: "task-1", images: [{ mimeType: "image/png", bytes }] })), generate: vi.fn() };
    const make = () => new AgentImageGenerationService(provider, jobs, assets, objectStorage, { resolve: vi.fn() }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key");
    const first = await make().execute({ prompt: "duck", purpose: "create", quality: "standard" }); const second = await make().execute({ prompt: "duck", purpose: "create", quality: "standard" });
    expect(first).toEqual(second); expect(provider.submit).toHaveBeenCalledOnce(); expect(provider.poll).toHaveBeenCalledOnce(); expect(assets.ensureGenerated).toHaveBeenCalledOnce(); expect(JSON.stringify(first)).not.toContain("base64");
  });

  it("rejects a changed request under the same idempotency key", async () => {
    const jobs = jobStore(); const provider: ImageGenerationPort = { provider: "fake", capabilities: { textToImage: true, referenceImages: false, asyncJobs: true, maxReferenceImages: 0 }, submit: vi.fn(), poll: vi.fn(), generate: vi.fn() };
    const service = (prompt: string) => new AgentImageGenerationService(provider, jobs, { ensureGenerated: vi.fn(), load: vi.fn(async () => null) }, storage(), { resolve: vi.fn() }, { fetch: vi.fn() }, "owner", "task", "run", "call", "key").execute({ prompt, purpose: "create", quality: "standard" });
    await expect(service("one")).rejects.toThrow();
    await expect(service("two")).rejects.toThrow("IMAGE_GENERATION_IDEMPOTENCY_CONFLICT");
  });
});
