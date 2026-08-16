/**
 * Model catalog.
 *
 * Two layers:
 *   - seed-catalog.json  58 KB, committed, 254 tool-capable models. Always there,
 *     works with no network. This is what a fresh phone sees.
 *   - ~/.tca/models.json  the full 3.8 MB models.dev dump, only downloaded when
 *     the user explicitly taps "Download full catalog" (never automatically -
 *     assume metered mobile data).
 *
 * Only tool-capable models are surfaced: this is a coding agent, a model that
 * cannot call tools cannot do anything useful here.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { STATE_DIR } from "./config.js";
import { PROVIDERS } from "./providers.js";

const require = createRequire(import.meta.url);
/** @type {{generated: string, providers: Record<string, {name: string, doc?: string, models: CatalogModel[]}>}} */
const SEED = require("./seed-catalog.json");

const FULL_PATH = path.join(STATE_DIR, "models.json");
const CATALOG_URL = "https://models.dev/api.json";

/**
 * @typedef {object} CatalogModel
 * @property {string} id
 * @property {string} name
 * @property {number|null} context
 * @property {number|null} output
 * @property {number|null} input_cost    USD per 1M input tokens
 * @property {number|null} output_cost   USD per 1M output tokens
 * @property {boolean} reasoning
 * @property {boolean} attachment
 */

/** @type {null | Record<string, {name: string, doc?: string, models: CatalogModel[]}>} */
let fullCache = null;

function loadFull() {
  if (fullCache) return fullCache;
  if (!fs.existsSync(FULL_PATH)) return null;
  try {
    /** @type {Record<string, any>} */
    const api = JSON.parse(fs.readFileSync(FULL_PATH, "utf8"));
    /** @type {Record<string, {name: string, doc?: string, models: CatalogModel[]}>} */
    const out = {};
    for (const [id, p] of Object.entries(api)) {
      out[id] = {
        name: p.name || id,
        doc: p.doc,
        models: Object.values(p.models || {})
          .filter((m) => m.tool_call)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            context: m.limit?.context ?? null,
            output: m.limit?.output ?? null,
            input_cost: m.cost?.input ?? null,
            output_cost: m.cost?.output ?? null,
            reasoning: Boolean(m.reasoning),
            attachment: Boolean(m.attachment),
          })),
      };
    }
    fullCache = out;
    return out;
  } catch {
    return null; // corrupt download, fall back to seed
  }
}

/** @returns {{ source: "full" | "seed", generated: string, providerCount: number, modelCount: number }} */
export function catalogInfo() {
  const full = loadFull();
  const src = full || SEED.providers;
  let models = 0;
  for (const p of Object.values(src)) models += p.models.length;
  return {
    source: full ? "full" : "seed",
    generated: full ? fs.statSync(FULL_PATH).mtime.toISOString().slice(0, 10) : SEED.generated,
    providerCount: Object.keys(src).length,
    modelCount: models,
  };
}

/**
 * Models for one provider id. Falls back to the seed when the full catalog is
 * absent, and to an empty list for local runtimes (llama.cpp etc.) whose model
 * list depends on whatever file the user loaded.
 * @param {string} providerId
 * @returns {CatalogModel[]}
 */
export function modelsFor(providerId) {
  const full = loadFull();
  return full?.[providerId]?.models ?? SEED.providers[providerId]?.models ?? [];
}

/**
 * Live model list straight from the provider's own /models route. Local
 * runtimes are the main reason this exists - only they know what is loaded.
 * @param {import("./config.js").ProviderConfig} provider
 * @returns {Promise<CatalogModel[]>}
 */
export async function fetchLiveModels(provider) {
  if (provider.kind === "anthropic") {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/models`, {
      headers: { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 200));
    const body = await res.json();
    return (body.data || []).map((m) => shapeLive(m.id, m.display_name));
  }
  const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
    headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 200));
  const body = await res.json();
  const list = body.data || body.models || [];
  return list.map((m) => shapeLive(m.id || m.name, m.name));
}

function shapeLive(id, name) {
  return {
    id,
    name: name || id,
    context: null,
    output: null,
    input_cost: null,
    output_cost: null,
    reasoning: false,
    attachment: false,
  };
}

/**
 * Search across every provider in the catalog. Powers the "I know the model
 * name but not the vendor" case, which is the common newbie situation.
 * @param {string} query
 * @param {number} [limit]
 */
export function searchModels(query, limit = 60) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const src = loadFull() || SEED.providers;
  /** @type {Array<{providerId: string, providerName: string, known: boolean, model: CatalogModel}>} */
  const hits = [];
  for (const [providerId, p] of Object.entries(src)) {
    for (const model of p.models) {
      if (`${model.id} ${model.name}`.toLowerCase().includes(q)) {
        hits.push({ providerId, providerName: p.name, known: providerId in PROVIDERS, model });
      }
    }
  }
  // Providers we can actually reach without the user pasting a base URL first.
  hits.sort((a, b) => Number(b.known) - Number(a.known));
  return hits.slice(0, limit);
}

/**
 * Download the full models.dev catalog. Explicit user action only.
 * @returns {Promise<{bytes: number, providers: number, models: number}>}
 */
export async function downloadFullCatalog() {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
  const text = await res.text();
  JSON.parse(text); // fail before overwriting a good cache
  fs.mkdirSync(path.dirname(FULL_PATH), { recursive: true });
  const tmp = `${FULL_PATH}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, FULL_PATH);
  fullCache = null;
  const info = catalogInfo();
  return { bytes: text.length, providers: info.providerCount, models: info.modelCount };
}

/**
 * Best default model for a provider: newest entry in the catalog, which is the
 * order gen-seed.mjs already wrote them in.
 * @param {string} providerId
 */
export function defaultModelFor(providerId) {
  return modelsFor(providerId)[0]?.id || "";
}
