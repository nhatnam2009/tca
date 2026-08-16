/**
 * Provider & Model auto-discovery.
 *
 * Fetches live model list from provider endpoints with fallback to the offline
 * models.dev catalog. Caches results in ~/.tca/discovered.json (TTL 24h).
 */

import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.js";
import { PROVIDERS } from "./providers.js";
import { modelsFor } from "./catalog.js";

export const DISCOVERED_PATH = path.join(STATE_DIR, "discovered.json");
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DISCOVER_TIMEOUT_MS = 5000;

/**
 * @typedef {object} DiscoveredModel
 * @property {string} id
 * @property {string} name
 * @property {number|null} context
 * @property {{ input: number|null, output: number|null } | null} [pricing]
 */

/**
 * Load the cached discovered models from disk.
 * @returns {Record<string, { timestamp: number, models: DiscoveredModel[] }>}
 */
export function loadDiscoveredCache() {
  if (!fs.existsSync(DISCOVERED_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DISCOVERED_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Save the discovered models cache to disk.
 * @param {Record<string, { timestamp: number, models: DiscoveredModel[] }>} cache
 */
export function saveDiscoveredCache(cache) {
  try {
    fs.mkdirSync(path.dirname(DISCOVERED_PATH), { recursive: true });
    const tmp = `${DISCOVERED_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, DISCOVERED_PATH);
  } catch {
    // Non-fatal if cache save fails
  }
}

/**
 * Get cached models for a provider if still valid.
 * @param {string} providerId
 * @param {number} [ttlMs]
 * @returns {DiscoveredModel[] | null}
 */
export function getCachedModels(providerId, ttlMs = DEFAULT_TTL_MS) {
  const cache = loadDiscoveredCache();
  const entry = cache[providerId];
  if (!entry || !Array.isArray(entry.models)) return null;
  if (Date.now() - entry.timestamp > ttlMs) return null;
  return entry.models;
}

/**
 * Set cached models for a provider.
 * @param {string} providerId
 * @param {DiscoveredModel[]} models
 */
export function setCachedModels(providerId, models) {
  const cache = loadDiscoveredCache();
  cache[providerId] = {
    timestamp: Date.now(),
    models,
  };
  saveDiscoveredCache(cache);
}

/**
 * Normalize model list from Anthropic endpoint.
 * @param {any} body
 * @returns {DiscoveredModel[]}
 */
export function normalizeAnthropicModels(body) {
  const list = Array.isArray(body?.data) ? body.data : [];
  return list
    .filter((m) => m && (m.id || m.name))
    .map((m) => ({
      id: m.id || m.name,
      name: m.display_name || m.name || m.id,
      context: m.max_input_tokens || null,
      pricing: null,
    }));
}

/**
 * Normalize model list from Google Gemini endpoint.
 * @param {any} body
 * @returns {DiscoveredModel[]}
 */
export function normalizeGeminiModels(body) {
  const list = Array.isArray(body?.models) ? body.models : [];
  return list
    .filter((m) => m && m.name)
    .map((m) => {
      const rawName = String(m.name);
      const id = rawName.startsWith("models/") ? rawName.slice(7) : rawName;
      return {
        id,
        name: m.displayName || id,
        context: m.inputTokenLimit || null,
        pricing: null,
      };
    });
}

/**
 * Normalize model list from OpenAI-compatible endpoint.
 * @param {any} body
 * @returns {DiscoveredModel[]}
 */
export function normalizeOpenAIModels(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return list
    .filter((m) => m && (m.id || m.name || m.model))
    .map((m) => {
      const id = m.id || m.name || m.model;
      const name = m.name || m.display_name || id;
      const context = m.context_length || m.context_window || (m.limit?.context ?? null);
      let pricing = null;
      if (m.pricing) {
        pricing = {
          input: m.pricing.prompt ? Number(m.pricing.prompt) * 1e6 : null,
          output: m.pricing.completion ? Number(m.pricing.completion) * 1e6 : null,
        };
      } else if (m.cost) {
        pricing = {
          input: m.cost.input ?? null,
          output: m.cost.output ?? null,
        };
      }
      return {
        id,
        name,
        context: typeof context === "number" ? context : null,
        pricing,
      };
    });
}

/**
 * Enrich discovered models with offline catalog metadata when available.
 * @param {string} providerId
 * @param {DiscoveredModel[]} live
 * @returns {DiscoveredModel[]}
 */
export function enrichWithCatalog(providerId, live) {
  const catalog = modelsFor(providerId);
  if (!catalog || !catalog.length) return live;
  const map = new Map(catalog.map((m) => [m.id, m]));
  return live.map((m) => {
    const cat = map.get(m.id);
    if (!cat) return m;
    return {
      id: m.id,
      name: m.name !== m.id ? m.name : cat.name || m.name,
      context: m.context ?? cat.context,
      pricing: m.pricing ?? (cat.input_cost !== null || cat.output_cost !== null
        ? { input: cat.input_cost, output: cat.output_cost }
        : null),
    };
  });
}

/**
 * Discover models live from provider endpoint.
 * Falls back to offline catalog on error or timeout.
 * @param {string} providerId
 * @param {string} [apiKey]
 * @param {string} [customBaseUrl]
 * @returns {Promise<DiscoveredModel[]>}
 */
export async function discoverModels(providerId, apiKey = "", customBaseUrl = "") {
  const known = PROVIDERS[providerId];
  const baseUrl = (customBaseUrl || known?.baseUrl || "").replace(/\/$/, "");

  // Offline fallback helper
  const fallback = () => {
    const offline = modelsFor(providerId);
    return offline.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context,
      pricing: m.input_cost !== null || m.output_cost !== null
        ? { input: m.input_cost, output: m.output_cost }
        : null,
    }));
  };

  const isAnthropic = providerId === "anthropic" || known?.kind === "anthropic";
  const isGemini = providerId === "google" || providerId === "gemini";

  try {
    const signal = AbortSignal.timeout(DISCOVER_TIMEOUT_MS);
    let res;
    let models = [];

    if (isAnthropic) {
      const url = `${baseUrl || "https://api.anthropic.com"}/v1/models`;
      res = await fetch(url, {
        headers: {
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          "anthropic-version": "2023-06-01",
        },
        signal,
      });
      if (res.ok) {
        const body = await res.json();
        models = normalizeAnthropicModels(body);
      }
    } else if (isGemini) {
      const url = apiKey
        ? `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
        : `https://generativelanguage.googleapis.com/v1beta/models`;
      res = await fetch(url, { signal });
      if (res.ok) {
        const body = await res.json();
        models = normalizeGeminiModels(body);
      }
    } else {
      const targetBase = baseUrl || "https://api.openai.com/v1";
      const url = `${targetBase}/models`;
      res = await fetch(url, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal,
      });
      if (res.ok) {
        const body = await res.json();
        models = normalizeOpenAIModels(body);
      }
    }

    if (models.length > 0) {
      return enrichWithCatalog(providerId, models);
    }
    return fallback();
  } catch {
    return fallback();
  }
}

/**
 * Discover models with caching layer.
 * @param {string} providerId
 * @param {object} [opts]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl]
 * @param {boolean} [opts.force]
 * @returns {Promise<DiscoveredModel[]>}
 */
export async function discoverOrCache(providerId, { apiKey = "", baseUrl = "", force = false } = {}) {
  if (!force) {
    const cached = getCachedModels(providerId);
    if (cached && cached.length > 0) return cached;
  }
  const models = await discoverModels(providerId, apiKey, baseUrl);
  if (models && models.length > 0) {
    setCachedModels(providerId, models);
  }
  return models;
}
