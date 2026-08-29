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
  readonly provider?: string;
  readonly capabilities?: ImageGenerationCapabilities;
  submit?(input: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationSubmission>;
  poll?(providerTaskId: string, signal?: AbortSignal): Promise<ImageGenerationPollResult>;
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

export type ImageGenerationCapabilities = {
  textToImage: boolean;
  referenceImages: boolean;
  asyncJobs: boolean;
  maxReferenceImages: number;
};

export type ImageReferenceInput = { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp" };
export type ImageGenerationRequest = {
  prompt: string;
  size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
  quality: "standard" | "high";
  referenceImages?: readonly ImageReferenceInput[];
};
export type ImageGenerationSubmission = { status: "submitted" | "completed"; providerTaskId?: string; images?: GeneratedImage[] };
export type ImageGenerationPollResult = { status: "pending" | "completed" | "failed"; providerTaskId: string; images?: GeneratedImage[]; error?: string };

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
