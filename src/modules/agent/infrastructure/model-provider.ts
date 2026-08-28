import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { createProviderFetchObserver } from "./provider-fetch-observer";

export type AgentModelProvider = "deepseek" | "openai" | "openai-compatible";
export type AgentReasoningMode = "disabled" | "enabled";

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
};

const parseProvider = (value: string | undefined): AgentModelProvider => {
  if (!value || value === "deepseek") return "deepseek";
  if (value === "openai") return "openai";
  if (value === "openai-compatible") return "openai-compatible";
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
      : { apiKey: env.PAPERDUCK_MODEL_API_KEY ?? env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY ?? "", baseUrl: env.PAPERDUCK_MODEL_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? env.OPENAI_BASE_URL ?? "", model: env.PAPERDUCK_MODEL ?? env.DEEPSEEK_MODEL ?? env.OPENAI_MODEL ?? "" };
  return { provider, reasoningMode, ...defaults };
};

export const createAgentLanguageModel = (config: AgentModelEnvironmentConfig) => {
  const fetch = createProviderFetchObserver({ provider: config.provider, model: config.model });
  if (config.provider === "deepseek") return createDeepSeek({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch }).chat(config.model);
  if (config.provider === "openai") return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch }).chat(config.model);
  return createOpenAICompatible({ apiKey: config.apiKey, baseURL: config.baseUrl, name: "paperduck-openai-compatible", fetch }).languageModel(config.model);
};

export const assertReasoningModeSupported = (config: AgentModelEnvironmentConfig) => {
  if (config.reasoningMode === "enabled" && config.provider !== "deepseek") {
    throw new AgentModelConfigurationError(`Reasoning mode is not supported by provider: ${config.provider}`);
  }
};
