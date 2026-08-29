import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { createProviderFetchObserver } from "./provider-fetch-observer";

export type AgentModelProvider = "deepseek" | "openai" | "openai-compatible" | "qwen";
export type AgentModelCapabilities = { text: boolean; toolCalling: boolean; vision: boolean };
export type AgentReasoningMode = "disabled" | "enabled";
export const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = 16_384;

export class AgentModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentModelConfigurationError";
  }
}

export type AgentModelEnvironmentConfig = {
  provider: AgentModelProvider;
  reasoningMode: AgentReasoningMode;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens?: number;
};

const parseMaxOutputTokens = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return DEFAULT_AGENT_MAX_OUTPUT_TOKENS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 131_072) {
    throw new AgentModelConfigurationError("PAPERDUCK_MODEL_MAX_OUTPUT_TOKENS must be a positive integer no greater than 131072");
  }
  return parsed;
};

const parseProvider = (value: string | undefined): AgentModelProvider => {
  if (!value || value === "deepseek") return "deepseek";
  if (value === "openai") return "openai";
  if (value === "openai-compatible") return "openai-compatible";
  if (value === "qwen") return "qwen";
  throw new AgentModelConfigurationError(`Unsupported PAPERDUCK_MODEL_PROVIDER: ${value}`);
};

const parseReasoningMode = (value: string | undefined): AgentReasoningMode => {
  if (!value || value === "disabled") return "disabled";
  if (value === "enabled") return "enabled";
  throw new AgentModelConfigurationError(`Unsupported PAPERDUCK_REASONING_MODE: ${value}`);
};

export const readAgentModelEnvironmentConfig = (env: Partial<NodeJS.ProcessEnv> = process.env): AgentModelEnvironmentConfig => {
  const provider = parseProvider(env.PAPERDUCK_MODEL_PROVIDER);
  const reasoningMode = parseReasoningMode(env.PAPERDUCK_REASONING_MODE);
  const defaults = provider === "deepseek"
    ? { apiKey: env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY ?? "", baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", model: env.DEEPSEEK_MODEL ?? "deepseek-v4-flash" }
    : provider === "openai"
      ? { apiKey: env.OPENAI_API_KEY ?? "", baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", model: env.OPENAI_MODEL ?? "gpt-4o-mini" }
      : provider === "qwen"
        ? { apiKey: env.QWEN_API_KEY ?? env.ALIYUN_AI_API_KEY ?? "", baseUrl: env.QWEN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1", model: env.QWEN_MODEL ?? "qwen3.7-plus" }
        : { apiKey: env.PAPERDUCK_MODEL_API_KEY ?? env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY ?? "", baseUrl: env.PAPERDUCK_MODEL_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? env.OPENAI_BASE_URL ?? "", model: env.PAPERDUCK_MODEL ?? env.DEEPSEEK_MODEL ?? env.OPENAI_MODEL ?? "" };
  return { provider, reasoningMode, maxOutputTokens: parseMaxOutputTokens(env.PAPERDUCK_MODEL_MAX_OUTPUT_TOKENS), ...defaults };
};

export const createAgentLanguageModel = (config: AgentModelEnvironmentConfig) => {
  const observedFetch = createProviderFetchObserver({ provider: config.provider, model: config.model });
  const fetch = config.provider === "qwen" ? createQwenFetch(observedFetch) : observedFetch;
  if (config.provider === "deepseek") return createDeepSeek({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch }).chat(config.model);
  if (config.provider === "openai") return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch }).chat(config.model);
  return createOpenAICompatible({ apiKey: config.apiKey, baseURL: config.baseUrl, name: "paperduck-openai-compatible", fetch, supportsStructuredOutputs: config.provider === "qwen" }).languageModel(config.model);
};

/** Qwen thinking is disabled at the wire boundary for every request. */
export const createQwenFetch = (baseFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!init?.body || typeof init.body !== "string") return baseFetch(input, init);
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    return baseFetch(input, { ...init, body: JSON.stringify({ ...body, enable_thinking: false }) });
  } catch {
    return baseFetch(input, init);
  }
};

export const agentModelCapabilities = (provider: AgentModelProvider): AgentModelCapabilities => ({
  text: true,
  toolCalling: true,
  vision: provider === "qwen",
});

export const assertReasoningModeSupported = (config: AgentModelEnvironmentConfig) => {
  if (config.reasoningMode === "enabled" && config.provider !== "deepseek") {
    throw new AgentModelConfigurationError(`Reasoning mode is not supported by provider: ${config.provider}`);
  }
};
