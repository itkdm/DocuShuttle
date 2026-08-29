import { generateText } from "ai";
import { z } from "zod";
import type { ImageVisionPort } from "../application/vision";
import { agentModelCapabilities, readAgentModelEnvironmentConfig, createAgentLanguageModel, assertReasoningModeSupported } from "./model-provider";

const analysisSchema = z.object({ summary: z.string().max(2_000), type: z.enum(["screenshot", "terminal", "diagram", "chart", "photo", "illustration", "logo", "other"]), visibleText: z.array(z.string().max(500)).max(50), layout: z.string().max(1_000).optional(), style: z.string().max(1_000).optional(), importantElements: z.array(z.string().max(500)).max(50), generationHints: z.array(z.string().max(500)).max(50) });
const instruction = (value?: string) => `${value ?? "简要描述图片中看到的内容。"}\n只输出 JSON，字段为 summary、type、visibleText、layout、style、importantElements、generationHints。不要输出 reasoning。`;

export class OpenAICompatibleImageVisionAdapter implements ImageVisionPort {
  private readonly model;
  constructor(config = readAgentModelEnvironmentConfig()) {
    assertReasoningModeSupported({ ...config, reasoningMode: "disabled" });
    if (!agentModelCapabilities(config.provider).vision) throw new Error("VISION_PROVIDER_UNAVAILABLE");
    this.model = createAgentLanguageModel({ ...config, reasoningMode: "disabled" });
  }
  async analyze(input: { bytes: Uint8Array; mimeType: string; instruction?: string }) {
    const result = await generateText({ model: this.model, messages: [{ role: "user", content: [{ type: "text", text: instruction(input.instruction) }, { type: "file", data: input.bytes, mediaType: input.mimeType }] }], maxOutputTokens: 2_048 });
    const text = result.text.replace(/^```json\s*|\s*```$/g, "").trim();
    return analysisSchema.parse(JSON.parse(text));
  }
}

export const createImageVisionFromEnvironment = () => {
  const config = readAgentModelEnvironmentConfig();
  return agentModelCapabilities(config.provider).vision ? new OpenAICompatibleImageVisionAdapter(config) : undefined;
};
