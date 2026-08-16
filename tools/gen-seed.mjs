/**
 * Regenerates src/seed-catalog.json from models.dev.
 *
 *   node tools/gen-seed.mjs
 *
 * The seed is the offline fallback shipped in git: it lets the Settings screen
 * show real providers and models on a fresh phone without downloading the full
 * 3.8 MB models.dev catalog over mobile data. Users can pull the full catalog
 * later from Settings.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../src/providers.js";
import { requiredSeedModels } from "../src/recommended.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "src", "seed-catalog.json");
const MODELS_PER_PROVIDER = 14;
const REQUIRED = requiredSeedModels();

const res = await fetch("https://models.dev/api.json");
if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
/** @type {Record<string, any>} */
const api = await res.json();

const providers = {};
let kept = 0;
/** @type {string[]} */
const missing = [];

for (const [id, known] of Object.entries(PROVIDERS)) {
  const upstream = api[id];
  if (!upstream) {
    // Local runtimes (llama.cpp, Ollama, LM Studio) are not in models.dev.
    providers[id] = { name: known.name, models: [] };
    continue;
  }
  const toolCapable = Object.values(upstream.models || {}).filter((m) => m.tool_call);
  const newest = toolCapable
    .slice()
    .sort((a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")));

  // Newest N, plus every model recommended.js points at, so the offline seed can
  // never disagree with the curated list.
  const picked = new Map(newest.slice(0, MODELS_PER_PROVIDER).map((m) => [m.id, m]));
  for (const wanted of REQUIRED[id] || []) {
    const found = toolCapable.find((m) => m.id === wanted);
    if (found) picked.set(wanted, found);
    else missing.push(`${id}/${wanted}`);
  }

  const models = [...picked.values()].map((m) => ({
    id: m.id,
    name: m.name,
    context: m.limit?.context ?? null,
    output: m.limit?.output ?? null,
    input_cost: m.cost?.input ?? null,
    output_cost: m.cost?.output ?? null,
    reasoning: Boolean(m.reasoning),
    attachment: Boolean(m.attachment),
  }));
  kept += models.length;
  providers[id] = { name: upstream.name || known.name, doc: upstream.doc, models };
}

const seed = {
  generated: new Date().toISOString().slice(0, 10),
  source: "https://models.dev/api.json",
  providers,
};

fs.writeFileSync(OUT, `${JSON.stringify(seed, null, 1)}\n`);
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`wrote ${OUT}`);
console.log(`${Object.keys(providers).length} providers, ${kept} models, ${kb} KB`);
if (missing.length) {
  console.error(`\nWARNING: recommended models not found upstream: ${missing.join(", ")}`);
  console.error("Fix src/recommended.js - the UI would offer a model the API will reject.");
  process.exitCode = 1;
}
