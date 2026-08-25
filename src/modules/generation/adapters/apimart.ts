import type { GeneratedImage } from "../domain";
import { ProviderConfigurationError, ProviderRequestError, type ImageGenerationPort } from "../ports";

type ErrorPayload = { error?: { message?: string } };
type SubmissionPayload = ErrorPayload & { data?: Array<{ status?: string; task_id?: string }> };
type TaskPayload = ErrorPayload & { data?: { id?: string; status?: "submitted" | "queued" | "processing" | "completed" | "failed"; result?: { images?: Array<{ url?: string[] }> } } };

export type APIMartAdapterOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  maxPolls?: number;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

const sizeToAspectRatio = { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3" } as const;

const wait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }, { once: true });
});

export class APIMartImageGenerationAdapter implements ImageGenerationPort {
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly options: APIMartAdapterOptions) {
    if (!options.apiKey || !options.baseUrl || !options.model) throw new ProviderConfigurationError("APIMart server configuration is incomplete");
    this.request = options.fetch ?? globalThis.fetch;
  }

  async generate(input: Parameters<ImageGenerationPort["generate"]>[0], signal?: AbortSignal): Promise<GeneratedImage[]> {
    const baseUrl = ensureTrailingSlash(this.options.baseUrl);
    const response = await this.request(new URL("v1/images/generations", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        prompt: input.prompt,
        n: input.count,
        size: sizeToAspectRatio[input.size],
        resolution: input.quality === "high" ? "2k" : "1k",
      }),
      signal,
    });
    const submission = (await response.json().catch(() => ({}))) as SubmissionPayload;
    if (!response.ok) throw requestError(response.status, submission, "submission");
    const taskId = submission.data?.[0]?.task_id;
    if (!taskId) throw new ProviderRequestError("APIMart returned no task identifier", "apimart", false);

    const delay = this.options.delay ?? wait;
    for (let poll = 0; poll < (this.options.maxPolls ?? 60); poll += 1) {
      await delay(this.options.pollIntervalMs ?? 2_000, signal);
      const taskResponse = await this.request(new URL(`v1/tasks/${encodeURIComponent(taskId)}?language=zh`, baseUrl), {
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        signal,
      });
      const task = (await taskResponse.json().catch(() => ({}))) as TaskPayload;
      if (!taskResponse.ok) throw requestError(taskResponse.status, task, "status check");
      if (task.data?.status === "failed") throw new ProviderRequestError("APIMart image task failed", "apimart", false);
      if (task.data?.status !== "completed") continue;
      const urls = task.data.result?.images?.flatMap((image) => image.url ?? []) ?? [];
      if (!urls.length) throw new ProviderRequestError("APIMart completed without image candidates", "apimart", false);
      return urls.map((remoteUrl) => ({ mimeType: "image/png", remoteUrl, providerRequestId: task.data?.id ?? taskId }));
    }
    throw new ProviderRequestError("APIMart image task timed out", "apimart", true, 408);
  }
}

const requestError = (status: number, payload: ErrorPayload, phase: string) => new ProviderRequestError(
  payload.error?.message ?? `APIMart ${phase} failed`,
  "apimart",
  status === 408 || status === 429 || status >= 500,
  status,
);

const ensureTrailingSlash = (value: string) => value.endsWith("/") ? value : `${value}/`;

export const createAPIMartAdapterFromEnvironment = () => new APIMartImageGenerationAdapter({
  apiKey: process.env.APIMART_API_KEY ?? "",
  baseUrl: process.env.APIMART_BASE_URL ?? "https://api.apimart.ai",
  model: process.env.APIMART_IMAGE_MODEL ?? "gpt-image-2",
});
