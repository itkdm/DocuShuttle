import { z } from "zod";

import type { TaskRepositoryPort } from "@/modules/tasks/ports";
import { buildTaskObjectKey } from "@/modules/storage/object-key";
import type { PrivateObjectStoragePort } from "@/modules/storage/ports";
import type { GeneratedImage } from "../domain";
import type { ImageGenerationPort } from "../ports";

const allowedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxImageBytes = 10 * 1024 * 1024;

export const generateImageCandidatesInputSchema = z.object({
  taskId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(4_000),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
  quality: z.enum(["standard", "high"]).default("standard"),
  count: z.number().int().min(1).max(4).default(1),
  targetNodeId: z.string().trim().min(1).max(256).optional(),
});

export type GenerateImageCandidatesInput = z.input<typeof generateImageCandidatesInputSchema> & {
  ownerUserId: string;
};

export type ImageBinary = {
  bytes: Uint8Array;
  mimeType: string;
};

export interface RemoteImageFetcherPort {
  fetch(url: string, signal?: AbortSignal): Promise<ImageBinary>;
}

export interface GeneratedAssetStorePort {
  create(input: {
    id: string;
    ownerUserId: string;
    taskId: string;
    objectKey: string;
    mimeType: string;
    sha256: string;
    provider: string;
    providerRequestId?: string;
    prompt: string;
  }): Promise<{ id: string }>;
}

export type ImageCandidateDto = {
  id: string;
  taskId: string;
  targetNodeId?: string;
  mimeType: string;
  downloadUrl: string;
  provider: string;
  providerRequestId?: string;
};

export class ImageGenerationInputError extends Error {
  readonly code = "IMAGE_GENERATION_INPUT_INVALID";
}

export class GenerateImageCandidates {
  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly images: ImageGenerationPort,
    private readonly storage: PrivateObjectStoragePort,
    private readonly assets: GeneratedAssetStorePort,
    private readonly fetcher: RemoteImageFetcherPort,
    private readonly signedUrlTtlSeconds = 5 * 60,
  ) {}

  async execute(rawInput: GenerateImageCandidatesInput): Promise<{ candidates: ImageCandidateDto[] }> {
    const input = generateImageCandidatesInputSchema.parse(rawInput);
    if (!await this.tasks.belongsToOwner(input.taskId, rawInput.ownerUserId)) {
      throw new ImageGenerationInputError("Task was not found.");
    }

    const generated = await this.images.generate({
      prompt: input.prompt,
      size: input.size,
      quality: input.quality,
      count: input.count,
    });
    const candidates: ImageCandidateDto[] = [];
    for (const image of generated.slice(0, input.count)) {
      const binary = await this.resolveBinary(image);
      if (!allowedMimeTypes.has(binary.mimeType)) {
        throw new ImageGenerationInputError("The image provider returned an unsupported image type.");
      }
      if (binary.bytes.byteLength === 0 || binary.bytes.byteLength > maxImageBytes) {
        throw new ImageGenerationInputError("The generated image exceeds the allowed size.");
      }

      const id = crypto.randomUUID();
      const extension = binary.mimeType === "image/jpeg" ? "jpg" : binary.mimeType.slice("image/".length);
      const objectKey = buildTaskObjectKey({
        userId: rawInput.ownerUserId,
        taskId: input.taskId,
        category: "assets",
        fileName: `${id}.${extension}`,
      });
      await this.storage.put(objectKey, binary.bytes, binary.mimeType);
      try {
        await this.assets.create({
          id,
          ownerUserId: rawInput.ownerUserId,
          taskId: input.taskId,
          objectKey,
          mimeType: binary.mimeType,
          sha256: await sha256(binary.bytes),
          provider: "apimart",
          providerRequestId: image.providerRequestId,
          prompt: input.prompt,
        });
        candidates.push({
          id,
          taskId: input.taskId,
          ...(input.targetNodeId ? { targetNodeId: input.targetNodeId } : {}),
          mimeType: binary.mimeType,
          downloadUrl: await this.storage.createSignedDownload(objectKey, this.signedUrlTtlSeconds),
          provider: "apimart",
          ...(image.providerRequestId ? { providerRequestId: image.providerRequestId } : {}),
        });
      } catch (error) {
        await this.storage.remove(objectKey).catch(() => undefined);
        throw error;
      }
    }
    if (!candidates.length) throw new ImageGenerationInputError("The image provider returned no candidates.");
    return { candidates };
  }

  private async resolveBinary(image: GeneratedImage): Promise<ImageBinary> {
    if (image.bytes) return { bytes: image.bytes, mimeType: image.mimeType };
    if (image.remoteUrl) return this.fetcher.fetch(image.remoteUrl);
    throw new ImageGenerationInputError("The image provider returned no image data.");
  }
}

const sha256 = async (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
};

export class RemoteImageFetcher implements RemoteImageFetcherPort {
  constructor(
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
    private readonly maxBytes = maxImageBytes,
  ) {}

  async fetch(url: string, signal?: AbortSignal): Promise<ImageBinary> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new ImageGenerationInputError("The provider returned an invalid image URL."); }
    if (parsed.protocol !== "https:") throw new ImageGenerationInputError("The provider returned an insecure image URL.");
    if (isPrivateHost(parsed.hostname)) throw new ImageGenerationInputError("The provider returned a private image URL.");
    const response = await this.request(parsed, { signal });
    if (!response.ok) throw new ImageGenerationInputError("The generated image could not be downloaded.");
    const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > this.maxBytes) throw new ImageGenerationInputError("The generated image exceeds the allowed size.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxBytes) throw new ImageGenerationInputError("The generated image exceeds the allowed size.");
    return { bytes, mimeType };
  }
}

const isPrivateHost = (hostname: string) => {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "[::1]" || value === "::1" || value.endsWith(".localhost")
    || /^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value);
};
