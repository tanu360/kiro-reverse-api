import { describe, expect, it } from "vitest";
import { modelOrigin } from "./model-maker";

describe("modelOrigin", () => {
  it.each([
    ["claude-sonnet-4-20250514", "claude"],
    ["claude-opus-4.8-thinking", "claude"],
    ["anthropic/claude-3.5-sonnet", "claude"],
    ["openrouter/anthropic/claude-opus-4", "claude"],
    ["us.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude"],
    ["gpt-4o-mini", "openai"],
    ["gpt-5.1-codex-max", "openai"],
    ["codex-mini-latest", "openai"],
    ["o1", "openai"],
    ["o3-mini", "openai"],
    ["o4-mini", "openai"],
    ["gemini-2.5-pro", "gemini"],
    ["gemma-3-27b", "gemma"],
    ["deepseek-reasoner", "deepseek"],
    ["grok-4", "grok"],
    ["llama-3.3-70b", "meta"],
    ["mistral-large", "mistral"],
    ["codestral-latest", "mistral"],
    ["qwen3-coder", "qwen"],
    ["kimi-k2", "kimi"],
    ["glm-4.6", "zhipu"],
    ["command-r-plus", "cohere"],
    ["sonar-pro", "perplexity"],
    ["minimax-m2", "minimax"],
    ["phi-4", "microsoft"],
    ["amazon.nova-pro-v1:0", "nova"],
    ["kiro-auto", "kiro"],
    ["auto", "kiro"],
    ["openrouter/auto-router", "openrouter"],
  ])("%s is %s", (model, origin) => {
    expect(modelOrigin(model)).toBe(origin);
  });

  it.each(["default", "future-flagship", "モデル-高速", "", "  "])(
    "%j names no company",
    (model) => {
      expect(modelOrigin(model)).toBeNull();
    },
  );

  it("does not read o-words or version numbers as OpenAI", () => {
    expect(modelOrigin("claude-opus-4-1-20250805")).toBe("claude");
    expect(modelOrigin("photo-model")).toBeNull();
  });
});
