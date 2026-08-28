import { logger } from "@/infrastructure/observability";

type ProviderFetchOptions = {
  model: string;
  provider: string;
};

const summarizeProviderError = (body: string) => {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : parsed;
    return {
      type: typeof error.type === "string" ? error.type : undefined,
      code: typeof error.code === "string" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message.slice(0, 500) : undefined,
    };
  } catch {
    return { bodyCharacterCount: body.length };
  }
};

export const createProviderFetchObserver = ({ model, provider }: ProviderFetchOptions) => {
  let requestSequence = 0;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestSequenceNumber = ++requestSequence;
    const startedAt = performance.now();
    logger.debug("agent.provider.request.started", {
      provider,
      model,
      requestSequence: requestSequenceNumber,
      method: init?.method ?? "GET",
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    });

    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      logger.error("agent.provider.request.failed", {
        provider,
        model,
        requestSequence: requestSequenceNumber,
        durationMs: performance.now() - startedAt,
        error,
      });
      throw error;
    }

    const responseMetadata = {
      provider,
      model,
      requestSequence: requestSequenceNumber,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") ?? undefined,
      contentLength: response.headers.get("content-length") ?? undefined,
      durationMs: performance.now() - startedAt,
    };
    logger.info("agent.provider.response.headers", responseMetadata);

    if (!response.ok) {
      void response.clone().text().then((body) => {
        logger.error("agent.provider.response.error", {
          ...responseMetadata,
          errorBody: summarizeProviderError(body),
        });
      }).catch((error) => {
        logger.warn("agent.provider.response.error_body_unreadable", {
          ...responseMetadata,
          error,
        });
      });
    }

    if (!response.body) {
      logger.warn("agent.provider.response.empty_body", responseMetadata);
      return response;
    }

    const reader = response.body.getReader();
    let chunkCount = 0;
    let bytesReceived = 0;
    let firstChunkMs: number | undefined;
    let settled = false;
    const finish = (event: "completed" | "failed" | "cancelled", metadata: Record<string, unknown> = {}) => {
      if (settled) return;
      settled = true;
      const level = event === "completed" ? "info" : event === "failed" ? "error" : "warn";
      logger[level](`agent.provider.stream.${event}`, {
        ...responseMetadata,
        durationMs: performance.now() - startedAt,
        firstChunkMs,
        chunkCount,
        bytesReceived,
        ...metadata,
      });
    };

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            finish("completed");
            controller.close();
            return;
          }
          if (firstChunkMs === undefined) firstChunkMs = performance.now() - startedAt;
          chunkCount += 1;
          bytesReceived += result.value.byteLength;
          controller.enqueue(result.value);
        } catch (error) {
          finish("failed", { error });
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish("cancelled", { cancelReason: reason });
        await reader.cancel(reason);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
};
