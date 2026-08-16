/**
 * Curated shortlist, in the spirit of OpenCode Zen: models actually worth
 * pointing a coding agent at.
 *
 * 5551 of the 6583 models on models.dev can call tools, which is still far too
 * many to hand a beginner. These are surfaced first; everything else sits behind
 * "show all models".
 *
 * Every id and price here was checked against models.dev, and gen-seed.mjs
 * guarantees each one is present in the bundled offline seed. Costs are USD per
 * 1M tokens (input/output) and drift, so treat them as a rough guide.
 */

/**
 * @typedef {object} Recommendation
 * @property {string} provider     provider id in providers.js
 * @property {string} model        model id as the API expects it
 * @property {string} label
 * @property {string} why
 * @property {"start" | "cheap" | "max"} tier
 */

/** @type {Recommendation[]} */
export const RECOMMENDED = [
  {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5 via OpenRouter",
    why: "Best all-round agent. One OpenRouter key also unlocks everything else below.",
    tier: "start",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    why: "Same model billed directly by Anthropic. ~$2/$10 per 1M tokens.",
    tier: "start",
  },
  {
    provider: "google",
    model: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    why: "Has a free tier at aistudio.google.com. 1M context, fast.",
    tier: "start",
  },
  {
    provider: "zai",
    model: "glm-4.7-flash",
    label: "GLM 4.7 Flash",
    why: "Free ($0/$0) and handles tool calls properly. Good first key to get.",
    tier: "cheap",
  },
  {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B on Groq",
    why: "Free tier, absurdly fast. Fine for small edits, weaker on long tasks.",
    tier: "cheap",
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    why: "~$0.14/$0.28 per 1M. Cheapest model that still finishes real tasks.",
    tier: "cheap",
  },
  {
    provider: "openrouter",
    model: "z-ai/glm-4.7",
    label: "GLM 4.7",
    why: "~$0.4/$1.75. Strong coder for the price.",
    tier: "cheap",
  },
  {
    provider: "openrouter",
    model: "moonshotai/kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    why: "Tuned for code, ~$0.71/$3.5. 262k context.",
    tier: "cheap",
  },
  {
    provider: "anthropic",
    model: "claude-opus-5",
    label: "Claude Opus 5",
    why: "Hardest debugging and refactors. ~$5/$25, so switch back down afterwards.",
    tier: "max",
  },
  {
    provider: "openai",
    model: "gpt-5.6",
    label: "GPT-5.6",
    why: "Strong alternative if you already pay OpenAI. ~$5/$30.",
    tier: "max",
  },
  {
    provider: "llamacpp",
    model: "",
    label: "On-device via llama.cpp",
    why: "Offline and free, but a phone-sized model calls tools badly. Curiosity, not daily driver.",
    tier: "max",
  },
];

export const TIERS = {
  start: { label: "Start here", hint: "Reliable defaults if you are not sure." },
  cheap: { label: "Cheap or free", hint: "Good value; fine for most edits." },
  max: { label: "Maximum capability", hint: "Expensive. Use for hard problems." },
};

/** Model ids the seed catalog must always contain, keyed by provider. */
export function requiredSeedModels() {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const r of RECOMMENDED) {
    if (!r.model) continue;
    (out[r.provider] ||= []).push(r.model);
  }
  return out;
}
