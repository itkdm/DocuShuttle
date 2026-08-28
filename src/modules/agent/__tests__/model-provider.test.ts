import { describe, expect, it } from "vitest";

import { AgentModelConfigurationError, assertReasoningModeSupported, readAgentModelEnvironmentConfig } from "../infrastructure/model-provider";

describe("agent model provider configuration", () => {
  it("selects DeepSeek and defaults reasoning to disabled", () => {
    expect(readAgentModelEnvironmentConfig({
      PAPERDUCK_MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_BASE_URL: "https://deepseek.test",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
    })).toEqual({ provider: "deepseek", reasoningMode: "disabled", apiKey: "key", baseUrl: "https://deepseek.test", model: "deepseek-v4-flash", maxOutputTokens: 16_384 });
  });

  it("fails deterministically when a provider has no reasoning capability", () => {
    expect(() => assertReasoningModeSupported({ provider: "openai-compatible", reasoningMode: "enabled", apiKey: "key", baseUrl: "https://gateway.test", model: "model" })).toThrow(AgentModelConfigurationError);
    expect(() => assertReasoningModeSupported({ provider: "openai", reasoningMode: "enabled", apiKey: "key", baseUrl: "https://openai.test", model: "model" })).toThrow(/not supported/);
  });

  it("rejects unknown provider and reasoning mode values", () => {
    expect(() => readAgentModelEnvironmentConfig({ PAPERDUCK_MODEL_PROVIDER: "unknown" })).toThrow(/Unsupported PAPERDUCK_MODEL_PROVIDER/);
    expect(() => readAgentModelEnvironmentConfig({ PAPERDUCK_REASONING_MODE: "maybe" })).toThrow(/Unsupported PAPERDUCK_REASONING_MODE/);
    expect(() => readAgentModelEnvironmentConfig({ PAPERDUCK_MODEL_MAX_OUTPUT_TOKENS: "NaN" })).toThrow(/PAPERDUCK_MODEL_MAX_OUTPUT_TOKENS/);
    expect(readAgentModelEnvironmentConfig({ PAPERDUCK_MODEL_MAX_OUTPUT_TOKENS: "8192" }).maxOutputTokens).toBe(8192);
  });
});
