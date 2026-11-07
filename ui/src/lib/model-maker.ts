import type { ModelMaker } from "@/components/shared/model-logos";

/** A model maker, or Kiro for its own `auto` routing. */
type ModelOrigin = ModelMaker | "kiro";

/*
 * Name patterns, most specific first. A routed name such as `openrouter/anthropic/claude-opus-4`
 * or `us.anthropic.claude-3-5-sonnet` names its model maker before its router, so the maker
 * wins and the router only counts when nothing else matches.
 */
const PATTERNS: ReadonlyArray<readonly [ModelOrigin, RegExp]> = [
  ["claude", /claude|anthropic|(^|[^a-z])(sonnet|opus|haiku)([^a-z]|$)/],
  ["gemma", /gemma/],
  ["gemini", /gemini|(^|[^a-z])(palm|bard)([^a-z]|$)/],
  ["deepseek", /deepseek/],
  ["grok", /grok|(^|[^a-z])xai([^a-z]|$)/],
  ["meta", /llama|(^|[^a-z])meta([^a-z]|$)/],
  ["mistral", /mistral|mixtral|codestral|ministral|pixtral|magistral|devstral/],
  ["qwen", /qwen|qwq|tongyi/],
  ["kimi", /kimi|moonshot/],
  ["zhipu", /(^|[^a-z])(glm|chatglm)|zhipu/],
  ["cohere", /cohere|(^|[^a-z])command(-|$)/],
  ["perplexity", /perplexity|pplx|(^|[^a-z])sonar([^a-z]|$)/],
  ["minimax", /minimax|(^|[^a-z])abab/],
  ["microsoft", /microsoft|(^|[^a-z])phi-?\d/],
  ["nova", /(^|[^a-z])(nova|titan)([^a-z]|$)|amazon\./],
  ["doubao", /doubao/],
  ["hunyuan", /hunyuan/],
  ["wenxin", /ernie|wenxin/],
  ["yi", /(^|[^a-z])yi-/],
  // o1, o3-mini, o4-mini: the letter o and a digit as a word of their own.
  ["openai", /gpt|chatgpt|openai|davinci|codex|dall-e|whisper|(^|[^a-z0-9])o\d([^a-z0-9]|$)/],
  ["kiro", /kiro|^auto$/],
  ["openrouter", /openrouter/],
];

/** The company behind a model name, or null when the name gives none away. */
export function modelOrigin(model: string): ModelOrigin | null {
  const name = model.trim().toLowerCase();
  if (!name) return null;
  for (const [origin, pattern] of PATTERNS) {
    if (pattern.test(name)) return origin;
  }
  return null;
}
