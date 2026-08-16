/**
 * First-run setup helpers.
 *
 * Goal: a newbie on a phone should get to a working agent without editing JSON.
 * Order of preference:
 *   1. keys already exported in the environment  -> zero taps
 *   2. the web UI wizard: pick provider, paste key, done
 *   3. hand-editing config.json                  -> still supported, never required
 */

import { loadConfig, saveConfig } from "./config.js";
import { PROVIDERS, detectFromEnv, providerDefaults } from "./providers.js";
import { defaultModelFor } from "./catalog.js";

/**
 * Add a config entry for every provider whose API key is already in the
 * environment, and pick the highest-ranked one as active. Idempotent: existing
 * entries are never overwritten.
 * @returns {{ added: string[], active: string }}
 */
export function seedFromEnv() {
  const { raw } = loadConfig();
  const found = detectFromEnv();
  /** @type {string[]} */
  const added = [];

  for (const { id, envName } of found) {
    if (raw.providers[id]) continue;
    const entry = providerDefaults(id);
    entry.apiKey = `\${${envName}}`; // keep the key in env, not in the file
    entry.model = defaultModelFor(id);
    raw.providers[id] = entry;
    added.push(id);
  }

  if (!raw.active || !raw.providers[raw.active]) {
    const best = Object.keys(raw.providers).sort(
      (a, b) => (PROVIDERS[a]?.rank ?? 50) - (PROVIDERS[b]?.rank ?? 50),
    )[0];
    raw.active = best || "";
  }

  if (added.length || raw.active) saveConfig(raw);
  return { added, active: raw.active };
}

/**
 * Wizard action: configure one provider and make it active.
 * @param {object} args
 * @param {string} args.id            provider id, or "other"
 * @param {string} [args.apiKey]      omitted for local runtimes
 * @param {string} [args.model]       defaults to newest catalog entry
 * @param {string} [args.baseUrl]     required when id is unknown / "other"
 * @param {"anthropic"|"openai"} [args.kind]
 * @param {string} [args.label]       config key to store under, defaults to id
 */
export function addProvider({ id, apiKey, model, baseUrl, kind, label }) {
  const { raw } = loadConfig();
  const key = label || id;
  const entry = providerDefaults(id);

  if (baseUrl) entry.baseUrl = baseUrl;
  if (kind) entry.kind = kind;
  if (apiKey) entry.apiKey = apiKey;
  entry.model = model || defaultModelFor(id) || entry.model;

  if (!entry.baseUrl) throw new Error(`Provider "${key}" needs a baseUrl`);
  if (!entry.model) throw new Error(`Provider "${key}" needs a model id`);

  raw.providers[key] = entry;
  raw.active = key;
  saveConfig(raw);
  return { id: key, provider: entry };
}

/**
 * Send the cheapest possible real request so the user finds out the key is
 * wrong now, rather than three messages into a task.
 * @param {import("./config.js").ProviderConfig} provider
 * @returns {Promise<{ok: true, model: string} | {ok: false, status?: number, error: string}>}
 */
export async function testProvider(provider) {
  const base = provider.baseUrl.replace(/\/$/, "");
  try {
    const res =
      provider.kind === "anthropic"
        ? await fetch(`${base}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": provider.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: provider.model,
              max_tokens: 1,
              messages: [{ role: "user", content: "hi" }],
            }),
          })
        : await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: provider.model,
              max_tokens: 1,
              max_completion_tokens: 1,
              messages: [{ role: "user", content: "hi" }],
            }),
          });

    if (res.ok) return { ok: true, model: provider.model };
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: res.status, error: explain(res.status, text) };
  } catch (err) {
    const e = /** @type {Error & {cause?: {code?: string}}} */ (err);
    const code = e.cause?.code;
    if (code === "ECONNREFUSED") {
      return { ok: false, error: `Nothing listening at ${base}. Is the local server running?` };
    }
    if (code === "ENOTFOUND") return { ok: false, error: `Cannot resolve host in ${base}.` };
    return { ok: false, error: e.message };
  }
}

function explain(status, body) {
  if (status === 401 || status === 403) return `Key rejected (${status}). Check the API key. ${body}`;
  if (status === 404) return `Model or endpoint not found (404). Check baseUrl and model id. ${body}`;
  if (status === 402) return `Payment required (402) - no credit on the account. ${body}`;
  if (status === 429) return `Rate limited (429). Key works, but you are throttled. ${body}`;
  return `HTTP ${status}. ${body}`;
}
