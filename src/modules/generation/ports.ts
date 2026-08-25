import type {
  DocumentPlan,
  GeneratedRegionText,
  GeneratedImage,
  PlanDocumentInput,
} from "./domain";

export interface TextReasoningPort {
  planDocument(input: PlanDocumentInput, signal?: AbortSignal): Promise<DocumentPlan>;
  generateRegionText(input: {
    goal: string;
    currentText: string;
    regionKind: "paragraph" | "tableCell";
    instruction?: string;
    surroundingText?: string;
  }, signal?: AbortSignal): Promise<GeneratedRegionText>;
}

export interface ImageGenerationPort {
  generate(
    input: {
      prompt: string;
      size: "1024x1024" | "1536x1024" | "1024x1536";
      quality: "standard" | "high";
      count: number;
    },
    signal?: AbortSignal,
  ): Promise<GeneratedImage[]>;
}

export class ProviderConfigurationError extends Error {
  readonly code = "PROVIDER_CONFIGURATION_ERROR";
}

export class ProviderRequestError extends Error {
  readonly code = "PROVIDER_REQUEST_ERROR";

  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}
