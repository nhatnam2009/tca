/**
 * Config loading/saving.
 *
 * Design goal: on a phone, the provider config must be editable with any
 * ordinary Android text editor / file manager. So when Termux shared storage
 * is available we keep the live config there by default:
 *
 *   ~/storage/shared/tca/config.json      ->  /sdcard/tca/config.json
 *
 * Resolution order:
 *   1. $TCA_CONFIG                        (explicit override, wins always)
 *   2. ~/storage/shared/tca/config.json   (default on Termux w/ storage granted)
 *   3. ~/.tca/config.json                 (desktop, or no storage permission)
 *
 * SECURITY: files under shared storage are readable by any app holding
 * "All files access" (MANAGE_EXTERNAL_STORAGE) - most file managers do. If you
 * do not want your API key sitting there, write "${ENV_NAME}" as the apiKey and
 * export the real value in ~/.bashrc instead. Env placeholders are expanded at
 * load time and are never written back to disk.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** @typedef {"anthropic" | "openai"} ProviderKind */

/**
 * @typedef {object} ProviderConfig
 * @property {ProviderKind} kind
 * @property {string} baseUrl
 * @property {string} apiKey            raw value, or "${ENV_NAME}"
 * @property {string} model             currently selected model id
 * @property {string[]} [models]        suggestions shown in the UI picker
 * @property {number} [maxTokens]       max *output* tokens per turn, not the context window
 * @property {boolean} [promptCache]    false disables Anthropic cache_control breakpoints
 * @property {number} [thinkingBudget]  Anthropic extended thinking budget, 0/absent = off
 * @property {"low"|"medium"|"high"} [reasoningEffort]  OpenAI-compatible reasoning knob
 * @property {Record<string,string>} [headers]
 */

/**
 * @typedef {object} Config
 * @property {string} active                        key into providers
 * @property {Record<string, ProviderConfig>} providers
 * @property {string} workspace                     agent is confined to this dir
 * @property {boolean} autoApproveCommands
 * @property {boolean} [autoApproveEdits]           false = confirm every file write
 * @property {"build"|"plan"} [mode]                plan mode removes every write tool
 * @property {boolean} [verifyEdits]                run the project's checker after a write
 * @property {"vi"|"en"} [lang]                     UI + doctor language
 * @property {string[]} [denyCommands]              extra regexes, always blocked
 * @property {number} [port]
 * @property {string} [instructions]                extra system prompt text
 * @property {{ maxCostPerSession?: number, maxTokensPerSession?: number, warnAtPercent?: number }} [budget]
 * @property {Record<string, "allow"|"ask"|"deny">} [permissions]
 * @property {Record<string, any>} [customAgents]
 */

const HOME = os.homedir();
export const SHARED_DIR = path.join(HOME, "storage", "shared", "tca");
export const PRIVATE_DIR = process.env.TCA_HOME || path.join(HOME, ".tca");

/** Where sessions/logs/token live. Never shared storage - contains chat history. */
export const STATE_DIR = PRIVATE_DIR;

/** @returns {string} absolute path of the config file we read and write */
export function configPath() {
  if (process.env.TCA_CONFIG) return path.resolve(process.env.TCA_CONFIG);
  const shared = path.join(SHARED_DIR, "config.json");
  if (fs.existsSync(shared)) return shared;
  // Prefer shared storage if Termux has it mounted, so the phone can edit it.
  if (fs.existsSync(path.dirname(SHARED_DIR))) return shared;
  return path.join(PRIVATE_DIR, "config.json");
}

/**
 * A fresh config has no providers at all. Instead of guessing, first run scans
 * the environment for keys the user already exported (see seedFromEnv) and the
 * web UI shows a one-screen setup wizard if nothing was found. Hardcoding four
 * half-configured providers just produced dead entries newbies had to delete.
 * @returns {Config}
 */
export function defaultConfig() {
  return {
    active: "",
    workspace: path.join(HOME, "projects"),
    autoApproveCommands: false,
    // Edits default to allowed: workspace confinement already bounds the damage,
    // and tapping Allow for every write on a phone makes the agent unusable.
    // Turn it off in Settings when pointing the agent at something you care about.
    autoApproveEdits: true,
    // build writes, plan does not. Plan mode is more useful on a phone than on a
    // desktop: you want to approve the approach before it spends forty steps of
    // your battery on it.
    mode: "build",
    // After a write, run whatever checker the project already has on the file that
    // changed and hand the errors back. This is the cheap stand-in for the LSP
    // diagnostics a desktop agent gets, and it is most of the value.
    verifyEdits: true,
    // Vietnamese by default: this is built for Termux users on a phone, and the
    // web UI has a switch. `tca doctor` reads it too.
    lang: "vi",
    port: 8787,
    instructions: "",
    denyCommands: [],
    budget: {
      maxCostPerSession: 0,
      maxTokensPerSession: 0,
      warnAtPercent: 80,
    },
    permissions: {
      bash: "ask",
      file_write: "allow",
      file_read: "allow",
      web_search: "allow",
      subagent: "allow",
      git: "allow",
    },
    customAgents: {},
    providers: {},
  };
}

/** Expand "${VAR}" against process.env. Leaves unknown vars as empty string. */
function expand(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => process.env[name] ?? "");
}

/**
 * Load config, creating it with defaults on first run.
 * @returns {{ config: Config, path: string, raw: Config }}
 *   `config` has env placeholders expanded, `raw` is exactly what is on disk.
 */
export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const seed = defaultConfig();
    writeConfigFile(file, seed);
    writeReadme(path.dirname(file));
  }
  /** @type {Config} */
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Config at ${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  const merged = { ...defaultConfig(), ...raw };
  merged.budget = { ...defaultConfig().budget, ...(raw.budget || {}) };
  merged.customAgents = { ...(raw.customAgents || {}) };

  const defaultPerms = defaultConfig().permissions;
  const rawPerms = raw.permissions || {};
  const mergedPerms = { ...defaultPerms, ...rawPerms };
  if (raw.permissions === undefined) {
    if (raw.autoApproveCommands !== undefined) {
      mergedPerms.bash = raw.autoApproveCommands ? "allow" : "ask";
      mergedPerms.git = raw.autoApproveCommands ? "allow" : "ask";
    }
    if (raw.autoApproveEdits !== undefined) {
      mergedPerms.file_write = raw.autoApproveEdits ? "allow" : "ask";
    }
  }
  merged.permissions = mergedPerms;

  merged.providers = { ...defaultConfig().providers, ...(raw.providers || {}) };

  /** @type {Config} */
  const resolved = structuredClone(merged);
  for (const p of Object.values(resolved.providers)) p.apiKey = expand(p.apiKey);
  resolved.workspace = path.resolve(expand(resolved.workspace));

  return { config: resolved, path: file, raw: merged };
}

function writeConfigFile(file, config) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Persist config. Keys arriving as the redaction sentinel keep their old value,
 * and a raw value identical to an existing "${VAR}" placeholder is not clobbered.
 * @param {Config} next
 */
export function saveConfig(next) {
  const file = configPath();
  const { raw: current } = loadConfig();
  const out = structuredClone(next);
  for (const [id, provider] of Object.entries(out.providers || {})) {
    const before = current.providers?.[id];
    if (!before) continue;
    if (provider.apiKey === REDACTED || provider.apiKey === "" || provider.apiKey == null) {
      provider.apiKey = before.apiKey;
    }
  }
  writeConfigFile(file, out);
  return file;
}

export const REDACTED = "__keep__";

/**
 * Copy of the on-disk config safe to send to the browser: real keys replaced
 * with the sentinel, placeholders left visible so the user knows they are used.
 * @param {Config} raw
 */
export function redactConfig(raw) {
  const out = structuredClone(raw);
  for (const p of Object.values(out.providers || {})) {
    const isPlaceholder = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(p.apiKey || "");
    if (isPlaceholder) continue;
    p.apiKey = p.apiKey ? REDACTED : "";
  }
  return out;
}

/** True when the active provider has a usable key after expansion. */
export function providerReady(config) {
  const p = config.providers[config.active];
  return Boolean(p && p.apiKey && p.baseUrl && p.model);
}

function writeReadme(dir) {
  const file = path.join(dir, "README.txt");
  if (fs.existsSync(file)) return;
  fs.writeFileSync(
    file,
    [
      "tca - config lives in config.json next to this file.",
      "",
      "Edit config.json with any text editor, then restart the daemon",
      "(or press Reload in the web UI Settings tab).",
      "",
      "WARNING: if this folder is /sdcard/tca, any app with 'All files access'",
      "can read your API keys here. To avoid that, set the key to ${MY_KEY}",
      "and put `export MY_KEY=sk-...` in ~/.bashrc instead.",
      "",
    ].join("\n"),
  );
}
