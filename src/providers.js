/**
 * Curated provider registry.
 *
 * models.dev tells us which *models* exist (6500+ across 185 providers) but not
 * how to reach them over HTTP. This table supplies the missing piece: base URL
 * and wire format. Every baseUrl here was probed and answers on its /models (or
 * /chat/completions) route.
 *
 * Only two wire formats are implemented:
 *   "anthropic" -> POST {baseUrl}/v1/messages           (x-api-key header)
 *   "openai"    -> POST {baseUrl}/chat/completions       (Bearer header)
 * ~165 of the 185 providers on models.dev speak the OpenAI shape, including
 * Gemini via its compatibility surface, so this covers nearly everything.
 *
 * Anything missing can still be used through the "other" pseudo-provider by
 * pasting a base URL, which is how opencode's custom providers work too.
 */

/**
 * @typedef {object} KnownProvider
 * @property {string} name
 * @property {"anthropic" | "openai"} kind
 * @property {string} baseUrl
 * @property {string[]} env         env var names checked for auto-setup
 * @property {string} [keyUrl]      where a newbie goes to get a key
 * @property {string} [keyPrefix]   sanity-check hint for the pasted key
 * @property {string} [note]
 * @property {number} [rank]        lower sorts first in the picker
 * @property {boolean} [local]      no API key needed, runs on device/LAN
 */

/** @type {Record<string, KnownProvider>} */
export const PROVIDERS = {
  openrouter: {
    name: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    keyUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-",
    note: "One key, hundreds of models from every vendor. Easiest starting point.",
    rank: 1,
  },
  anthropic: {
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    env: ["ANTHROPIC_API_KEY"],
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
    note: "Claude. Strongest tool-calling for coding agents.",
    rank: 2,
  },
  google: {
    name: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    keyUrl: "https://aistudio.google.com/apikey",
    note: "Has a free tier. Uses Gemini's OpenAI-compatible endpoint.",
    rank: 3,
  },
  openai: {
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
    keyUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
    rank: 4,
  },
  deepseek: {
    name: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    env: ["DEEPSEEK_API_KEY"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPrefix: "sk-",
    note: "Very cheap, good at code.",
    rank: 5,
  },
  groq: {
    name: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    env: ["GROQ_API_KEY"],
    keyUrl: "https://console.groq.com/keys",
    keyPrefix: "gsk_",
    note: "Free tier, extremely fast. Open-weight models only.",
    rank: 6,
  },
  xai: {
    name: "xAI Grok",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    env: ["XAI_API_KEY"],
    keyUrl: "https://console.x.ai",
    keyPrefix: "xai-",
    rank: 7,
  },
  // models.dev calls this "zai"; keep the same id so the catalog lines up.
  zai: {
    name: "Z.AI (GLM)",
    kind: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    env: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    note: "GLM models. Popular for agent use, cheap coding plans.",
    rank: 8,
  },
  moonshotai: {
    name: "Moonshot (Kimi)",
    kind: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    env: ["MOONSHOT_API_KEY"],
    rank: 9,
  },
  alibaba: {
    name: "Alibaba Qwen",
    kind: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    env: ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY"],
    note: "International DashScope endpoint.",
    rank: 10,
  },
  mistral: {
    name: "Mistral",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    env: ["MISTRAL_API_KEY"],
    rank: 11,
  },
  cerebras: {
    name: "Cerebras",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    env: ["CEREBRAS_API_KEY"],
    keyPrefix: "csk-",
    rank: 12,
  },
  togetherai: {
    name: "Together AI",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    env: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
    rank: 13,
  },
  "fireworks-ai": {
    name: "Fireworks AI",
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    env: ["FIREWORKS_API_KEY"],
    rank: 14,
  },
  deepinfra: {
    name: "DeepInfra",
    kind: "openai",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    env: ["DEEPINFRA_API_KEY"],
    rank: 15,
  },
  novita: {
    name: "Novita",
    kind: "openai",
    baseUrl: "https://api.novita.ai/v3/openai",
    env: ["NOVITA_API_KEY"],
    rank: 16,
  },
  nebius: {
    name: "Nebius",
    kind: "openai",
    baseUrl: "https://api.studio.nebius.com/v1",
    env: ["NEBIUS_API_KEY"],
    rank: 17,
  },
  hyperbolic: {
    name: "Hyperbolic",
    kind: "openai",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    env: ["HYPERBOLIC_API_KEY"],
    rank: 18,
  },
  sambanova: {
    name: "SambaNova",
    kind: "openai",
    baseUrl: "https://api.sambanova.ai/v1",
    env: ["SAMBANOVA_API_KEY"],
    rank: 19,
  },
  baseten: {
    name: "Baseten",
    kind: "openai",
    baseUrl: "https://inference.baseten.co/v1",
    env: ["BASETEN_API_KEY"],
    rank: 20,
  },
  huggingface: {
    name: "Hugging Face",
    kind: "openai",
    baseUrl: "https://router.huggingface.co/v1",
    env: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
    keyPrefix: "hf_",
    rank: 21,
  },
  venice: {
    name: "Venice AI",
    kind: "openai",
    baseUrl: "https://api.venice.ai/api/v1",
    env: ["VENICE_API_KEY"],
    rank: 22,
  },
  upstage: {
    name: "Upstage",
    kind: "openai",
    baseUrl: "https://api.upstage.ai/v1",
    env: ["UPSTAGE_API_KEY"],
    rank: 23,
  },
  minimax: {
    name: "MiniMax",
    kind: "openai",
    baseUrl: "https://api.minimax.chat/v1",
    env: ["MINIMAX_API_KEY"],
    rank: 24,
  },
  zhipuai: {
    name: "Zhipu AI (mainland)",
    kind: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    env: ["ZHIPU_API_KEY"],
    rank: 25,
  },
  perplexity: {
    name: "Perplexity",
    kind: "openai",
    baseUrl: "https://api.perplexity.ai",
    env: ["PERPLEXITY_API_KEY"],
    keyPrefix: "pplx-",
    rank: 26,
  },
  "vercel-gateway": {
    name: "Vercel AI Gateway",
    kind: "openai",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    env: ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_KEY"],
    note: "Also a multi-vendor gateway, like OpenRouter.",
    rank: 27,
  },

  // ---- On-device / LAN. No key required. -----------------------------------
  llamacpp: {
    name: "llama.cpp server (on device)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:8080/v1",
    env: [],
    local: true,
    note: "pkg install llama-cpp, then llama-server -m model.gguf. Slow on phone; small models handle tools poorly.",
    rank: 40,
  },
  ollama: {
    name: "Ollama (on device or LAN)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    env: [],
    local: true,
    note: "Point baseUrl at your PC's LAN IP to use a desktop GPU from the phone.",
    rank: 41,
  },
  lmstudio: {
    name: "LM Studio (LAN)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    env: [],
    local: true,
    rank: 42,
  },
};

/** The pseudo-provider used for anything not in the table. */
export const OTHER = {
  id: "other",
  name: "Other (OpenAI-compatible)",
  kind: /** @type {"openai"} */ ("openai"),
  baseUrl: "",
  env: [],
  note: "Paste any OpenAI-compatible base URL, e.g. https://host/v1",
  rank: 99,
};

/** @returns {Array<KnownProvider & {id: string}>} sorted for the picker */
export function listProviders() {
  return Object.entries(PROVIDERS)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.rank ?? 50) - (b.rank ?? 50) || a.name.localeCompare(b.name));
}

/**
 * Default provider entry for a given id, ready to be written into config.
 * @param {string} id
 * @returns {import("./config.js").ProviderConfig}
 */
export function providerDefaults(id) {
  const known = PROVIDERS[id];
  if (!known) {
    return { kind: "openai", baseUrl: "", apiKey: "", model: "", maxTokens: 8192 };
  }
  return {
    kind: known.kind,
    baseUrl: known.baseUrl,
    apiKey: known.local ? "" : `\${${known.env[0] || `${id.toUpperCase()}_API_KEY`}}`,
    model: "",
    maxTokens: 8192,
  };
}

/**
 * Providers whose key is already exported in the environment. Used on first run
 * so an existing ~/.bashrc export means zero setup.
 * @param {NodeJS.ProcessEnv} env
 */
export function detectFromEnv(env = process.env) {
  /** @type {Array<{id: string, envName: string}>} */
  const found = [];
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const envName = p.env.find((name) => env[name]);
    if (envName) found.push({ id, envName });
  }
  return found.sort((a, b) => (PROVIDERS[a.id].rank ?? 50) - (PROVIDERS[b.id].rank ?? 50));
}
