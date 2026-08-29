import { describe, expect, it } from "vitest";

import { AgentModelConfigurationError, agentModelCapabilities, assertReasoningModeSupported, createQwenFetch, readAgentModelEnvironmentConfig } from "../infrastructure/model-provider";

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

  it("configures Qwen through the compatible provider with vision capability", () => {
    expect(readAgentModelEnvironmentConfig({
      PAPERDUCK_MODEL_PROVIDER: "qwen",
      QWEN_API_KEY: "qwen-key",
      QWEN_BASE_URL: "https://qwen.test/v1",
      QWEN_MODEL: "qwen-vision-test",
    })).toMatchObject({ provider: "qwen", apiKey: "qwen-key", baseUrl: "https://qwen.test/v1", model: "qwen-vision-test", reasoningMode: "disabled" });
    expect(agentModelCapabilities("qwen").vision).toBe(true);
    expect(agentModelCapabilities("deepseek").vision).toBe(false);
    expect(() => assertReasoningModeSupported({ provider: "qwen", reasoningMode: "enabled", apiKey: "key", baseUrl: "https://qwen.test", model: "model" })).toThrow(/not supported/);
  });

  it("forces Qwen thinking off without changing non-JSON requests", async () => {
    let forwarded: RequestInit | undefined;
    const wrapped = createQwenFetch(async (_input, init) => {
      forwarded = init;
      return new Response("ok");
    });
    await wrapped("https://qwen.test", { method: "POST", body: JSON.stringify({ model: "qwen", messages: [] }) });
    expect(JSON.parse(String(forwarded?.body))).toMatchObject({ model: "qwen", enable_thinking: false });
    await wrapped("https://qwen.test", { method: "GET" });
    expect(forwarded?.method).toBe("GET");
  });
});
